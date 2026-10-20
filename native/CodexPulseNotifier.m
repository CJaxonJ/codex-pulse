#import <Cocoa/Cocoa.h>
#import <UserNotifications/UserNotifications.h>

@interface CodexPulseDelegate : NSObject <NSApplicationDelegate, UNUserNotificationCenterDelegate>
@property(nonatomic, copy) NSString *notificationTitle;
@property(nonatomic, copy) NSString *notificationBody;
@property(nonatomic, assign) BOOL setupMode;
@property(nonatomic, assign) BOOL timeSensitive;
@property(nonatomic, assign) BOOL statusMode;
@property(nonatomic, assign) BOOL persistentMode;
@property(nonatomic, assign) BOOL persistentSelfTestMode;
@property(nonatomic, assign) BOOL persistentSelfTestPassed;
@end

@implementation CodexPulseDelegate

- (void)writeLog:(NSString *)message {
    NSURL *home = [NSURL fileURLWithPath:NSHomeDirectory()];
    NSURL *directory = [[[home URLByAppendingPathComponent:@"Library"]
        URLByAppendingPathComponent:@"Application Support"]
        URLByAppendingPathComponent:@"Codex Pulse"];
    [[NSFileManager defaultManager] createDirectoryAtURL:directory
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    NSURL *file = [directory URLByAppendingPathComponent:@"notifier.log"];
    NSString *line = [NSString stringWithFormat:@"[%@] %@\n", [NSDate date], message];
    NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
    if ([[NSFileManager defaultManager] fileExistsAtPath:file.path]) {
        NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:file.path];
        [handle seekToEndOfFile];
        [handle writeData:data];
        [handle closeFile];
    } else {
        [data writeToURL:file atomically:YES];
    }
}

- (void)finishAfterDelay {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        [NSApp terminate:nil];
    });
}

- (void)showPermissionHelp:(NSString *)message {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"通知权限尚未开启";
        alert.informativeText = message;
        [alert addButtonWithTitle:@"打开通知设置"];
        [alert addButtonWithTitle:@"稍后"];
        if ([alert runModal] == NSAlertFirstButtonReturn) {
            NSURL *url = [NSURL URLWithString:@"x-apple.systempreferences:com.apple.Notifications-Settings.extension"];
            [[NSWorkspace sharedWorkspace] openURL:url];
        }
        [NSApp terminate:nil];
    });
}

- (void)showPersistentAlert {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = self.notificationTitle;
        alert.informativeText = self.notificationBody;
        [alert addButtonWithTitle:@"知道了"];
        [alert addButtonWithTitle:@"查看状态"];
        alert.window.level = NSFloatingWindowLevel;
        alert.window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                          NSWindowCollectionBehaviorTransient;
        [NSApp activateIgnoringOtherApps:YES];
        [alert.window center];
        [alert.window orderFrontRegardless];
        [self writeLog:[NSString stringWithFormat:@"persistent alert presented: %@", self.notificationTitle]];
        if (self.persistentSelfTestMode) {
            NSTimer *timer = [NSTimer timerWithTimeInterval:3 repeats:NO block:^(NSTimer *timer) {
                self.persistentSelfTestPassed = alert.window.isVisible && NSApp.modalWindow == alert.window;
                [self writeLog:self.persistentSelfTestPassed
                    ? @"persistent self-test passed: alert remained visible for 3 seconds"
                    : @"persistent self-test failed: alert was not visible after 3 seconds"];
                [NSApp abortModal];
                [alert.window orderOut:nil];
            }];
            [[NSRunLoop mainRunLoop] addTimer:timer forMode:NSModalPanelRunLoopMode];
        }
        NSModalResponse response = [alert runModal];
        if (self.persistentSelfTestMode) {
            printf("{\"ok\":%s,\"visibleForSeconds\":3}\n",
                   self.persistentSelfTestPassed ? "true" : "false");
            fflush(stdout);
            [NSApp terminate:nil];
            return;
        }
        [self writeLog:[NSString stringWithFormat:@"persistent alert dismissed: %@", self.notificationTitle]];
        if (response == NSAlertSecondButtonReturn) {
            [self showStatusPanel];
        } else {
            [NSApp terminate:nil];
        }
    });
}

- (void)finishDelivery {
    if (!self.persistentMode) {
        [self finishAfterDelay];
    }
}

- (NSDictionary *)readJSON:(NSString *)name {
    NSURL *home = [NSURL fileURLWithPath:NSHomeDirectory()];
    NSURL *directory = [[[home URLByAppendingPathComponent:@"Library"]
        URLByAppendingPathComponent:@"Application Support"]
        URLByAppendingPathComponent:@"Codex Pulse"];
    NSURL *file = [directory URLByAppendingPathComponent:name];
    NSData *data = [NSData dataWithContentsOfURL:file];
    if (!data) return @{};
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [parsed isKindOfClass:[NSDictionary class]] ? parsed : @{};
}

- (NSString *)formatUnixTime:(NSNumber *)timestamp {
    if (![timestamp isKindOfClass:[NSNumber class]]) return @"未知";
    NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
    formatter.locale = [NSLocale localeWithLocaleIdentifier:@"zh_CN"];
    formatter.dateFormat = @"M月d日 HH:mm";
    return [formatter stringFromDate:[NSDate dateWithTimeIntervalSince1970:timestamp.doubleValue]];
}

- (void)showStatusPanel {
    NSDictionary *state = [self readJSON:@"state.json"];
    NSDictionary *summary = [state[@"lastSummary"] isKindOfClass:[NSDictionary class]]
        ? state[@"lastSummary"] : @{};
    NSDictionary *fiveHour = [summary[@"fiveHour"] isKindOfClass:[NSDictionary class]]
        ? summary[@"fiveHour"] : @{};
    NSDictionary *preferences = [self readJSON:@"preferences.json"];
    NSDictionary *journal = [self readJSON:@"user-events.json"];
    NSArray *events = [journal[@"events"] isKindOfClass:[NSArray class]]
        ? journal[@"events"] : @[];
    NSDictionary *latest = [events.lastObject isKindOfClass:[NSDictionary class]]
        ? events.lastObject : @{};

    NSNumber *remaining = fiveHour[@"remainingPercent"];
    NSString *remainingText = [remaining isKindOfClass:[NSNumber class]]
        ? [NSString stringWithFormat:@"%.0f%%", remaining.doubleValue]
        : @"暂未读到";
    NSString *resetText = [self formatUnixTime:fiveHour[@"resetsAt"]];
    NSString *policy = [preferences[@"quotaPolicy"] isKindOfClass:[NSString class]]
        ? preferences[@"quotaPolicy"] : @"strict_reserve";
    NSDictionary *policyNames = @{
        @"strict_reserve": @"10% 自动暂停并保存检查点",
        @"finish_current": @"优先完成当前结果",
        @"deadline": @"截止日期模式"
    };
    NSString *policyText = policyNames[policy] ?: policy;

    NSString *eventText = @"还没有关键事件";
    if (latest.count > 0) {
        NSString *title = [latest[@"title"] isKindOfClass:[NSString class]]
            ? latest[@"title"] : @"Codex Pulse";
        NSString *body = [latest[@"body"] isKindOfClass:[NSString class]]
            ? latest[@"body"] : @"";
        if (body.length > 240) body = [[body substringToIndex:240] stringByAppendingString:@"…"];
        NSString *delivery = [latest[@"deliveryStatus"] isEqual:@"failed"]
            ? @"（系统通知发送失败，但事件已记录）" : @"";
        eventText = [NSString stringWithFormat:@"%@%@\n%@\n%@",
            title, delivery, body, [self formatUnixTime:latest[@"occurredAt"]]];
    }

    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"Codex Pulse 状态";
    alert.informativeText = [NSString stringWithFormat:
        @"5 小时额度：%@\n预计恢复：%@\n保护策略：%@\n\n最近事件\n%@",
        remainingText, resetText, policyText, eventText];
    [alert addButtonWithTitle:@"关闭"];
    [alert addButtonWithTitle:@"通知设置"];
    [NSApp activateIgnoringOtherApps:YES];
    if ([alert runModal] == NSAlertSecondButtonReturn) {
        NSURL *url = [NSURL URLWithString:@"x-apple.systempreferences:com.apple.Notifications-Settings.extension"];
        [[NSWorkspace sharedWorkspace] openURL:url];
    }
    [NSApp terminate:nil];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    if (self.persistentSelfTestMode) {
        [self showPersistentAlert];
        return;
    }
    if (self.statusMode) {
        [self showStatusPanel];
        return;
    }
    if (self.setupMode) {
        NSAlert *intro = [[NSAlert alloc] init];
        intro.messageText = @"开启 Codex Pulse 额度提醒";
        intro.informativeText = @"Codex Pulse 会在 5 小时额度剩余 20%、10%、5% 时提醒你，也会在消耗速度过快时提前预警。接下来 macOS 可能询问通知权限，请选择“允许”。";
        [intro addButtonWithTitle:@"继续"];
        [intro addButtonWithTitle:@"暂不开启"];
        if ([intro runModal] != NSAlertFirstButtonReturn) {
            [self writeLog:@"setup cancelled"];
            [NSApp terminate:nil];
            return;
        }
        self.notificationTitle = @"Codex Pulse 已就绪";
        self.notificationBody = @"这是一条测试通知，不代表真实额度。真实提醒会明确显示当前剩余百分比。";
    }

    // Present the must-see alert independently of Notification Center. Banner
    // lifetime is controlled by macOS and may be only a few seconds. Keeping
    // this helper process alive makes the second surface remain until the user
    // explicitly dismisses it.
    if (self.persistentMode) {
        [self showPersistentAlert];
    }

    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    center.delegate = self;
    [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                          completionHandler:^(BOOL granted, NSError * _Nullable error) {
        if (error) {
            [self writeLog:[NSString stringWithFormat:@"authorization error: %@", error.localizedDescription]];
            if (self.setupMode) {
                [self showPermissionHelp:@"请在“系统设置 → 通知 → Codex Pulse”中打开“允许通知”。"];
            } else {
                [self finishDelivery];
            }
            return;
        }
        if (!granted) {
            [self writeLog:@"authorization denied"];
            if (self.setupMode) {
                [self showPermissionHelp:@"监控仍会运行，但不会弹出预警。可以稍后在系统通知设置中重新开启 Codex Pulse。"];
            } else {
                [self finishDelivery];
            }
            return;
        }

        UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
        content.title = self.notificationTitle;
        content.body = self.notificationBody;
        content.sound = [UNNotificationSound defaultSound];
        if (self.timeSensitive) {
            if (@available(macOS 12.0, *)) {
                content.interruptionLevel = UNNotificationInterruptionLevelTimeSensitive;
            }
        }
        NSString *identifier = [NSString stringWithFormat:@"codex-pulse-%@", NSUUID.UUID.UUIDString];
        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier
                                                                               content:content
                                                                               trigger:nil];
        [center addNotificationRequest:request withCompletionHandler:^(NSError * _Nullable addError) {
            if (addError) {
                [self writeLog:[NSString stringWithFormat:@"delivery error: %@", addError.localizedDescription]];
            } else {
                [self writeLog:[NSString stringWithFormat:@"notification delivered: %@", self.notificationTitle]];
            }
            [self finishDelivery];
        }];
    }];
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
        didReceiveNotificationResponse:(UNNotificationResponse *)response
                 withCompletionHandler:(void (^)(void))completionHandler {
    [self showStatusPanel];
    completionHandler();
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions options))completionHandler {
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound);
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
        NSString *title = arguments.count > 1 ? arguments[1] : @"Codex Pulse";
        NSString *body = arguments.count > 2 ? arguments[2] : @"额度监控已启动。";
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        CodexPulseDelegate *delegate = [[CodexPulseDelegate alloc] init];
        delegate.setupMode = [arguments containsObject:@"--setup"];
        delegate.timeSensitive = [arguments containsObject:@"--time-sensitive"];
        delegate.persistentSelfTestMode = [arguments containsObject:@"--persistent-self-test"];
        delegate.persistentMode = [arguments containsObject:@"--persistent"] || delegate.persistentSelfTestMode;
        delegate.statusMode = arguments.count == 1 || [arguments containsObject:@"--status"];
        delegate.notificationTitle = title;
        delegate.notificationBody = body;
        if (delegate.persistentMode) {
            [NSProcessInfo.processInfo disableSuddenTermination];
            [NSProcessInfo.processInfo disableAutomaticTermination:@"Codex Pulse persistent alert"];
        }
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
