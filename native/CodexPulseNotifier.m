#import <Cocoa/Cocoa.h>
#import <UserNotifications/UserNotifications.h>
#import "PulseSettingsWindow.h"

@interface CodexPulseDelegate : NSObject <NSApplicationDelegate, UNUserNotificationCenterDelegate>
@property(nonatomic, copy) NSString *notificationTitle;
@property(nonatomic, copy) NSString *notificationBody;
@property(nonatomic, assign) BOOL setupMode;
@property(nonatomic, assign) BOOL timeSensitive;
@property(nonatomic, assign) BOOL statusMode;
@property(nonatomic, assign) BOOL persistentMode;
@property(nonatomic, assign) BOOL persistentSelfTestMode;
@property(nonatomic, assign) BOOL persistentSelfTestPassed;
@property(nonatomic, assign) BOOL previewMode;
@property(nonatomic, assign) BOOL previewAction;
@property(nonatomic, assign) BOOL previewSelfTest;
@property(nonatomic, copy) NSString *severity;
@property(nonatomic, strong) PulseSettingsWindow *settingsWindow;
@property(nonatomic, assign) BOOL settingsSelfTest;
@property(nonatomic, assign) BOOL silent;
@end

@implementation CodexPulseDelegate

- (NSString *)dataDirectory {
    NSString *override = NSProcessInfo.processInfo.environment[@"CODEX_PULSE_DATA_DIR"];
    return override.length ? override : [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/Codex Pulse"];
}

- (NSString *)severityLabel:(NSString *)severity {
    if ([severity isEqual:@"critical"]) return @"● 重要 · 立即关注";
    if ([severity isEqual:@"warning"]) return @"▲ 注意 · 提前准备";
    return @"● 信息";
}

- (NSTextField *)severityBadge:(NSString *)severity {
    NSTextField *badge = [NSTextField labelWithString:[self severityLabel:severity]];
    badge.font = [NSFont boldSystemFontOfSize:13];
    badge.textColor = [severity isEqual:@"critical"] ? NSColor.systemRedColor
        : [severity isEqual:@"warning"] ? NSColor.systemOrangeColor : NSColor.secondaryLabelColor;
    [badge sizeToFit];
    return badge;
}

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
        if (!self.settingsWindow) [NSApp terminate:nil];
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
        alert.accessoryView = [self severityBadge:self.severity];
        [alert addButtonWithTitle:@"知道了"];
        [alert addButtonWithTitle:self.previewAction ? @"查看续跑计划" : @"查看状态"];
        alert.window.level = NSFloatingWindowLevel;
        alert.window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                                          NSWindowCollectionBehaviorTransient;
        [NSApp activateIgnoringOtherApps:YES];
        [alert.window center];
        [alert.window orderFrontRegardless];
        [self writeLog:[NSString stringWithFormat:@"persistent alert presented: %@", self.notificationTitle]];
        if (self.persistentSelfTestMode) {
            NSTimer *timer = [NSTimer timerWithTimeInterval:3 repeats:NO block:^(NSTimer *timer) {
                // The product promise is that the must-see window remains visible.
                // `modalWindow` can temporarily be nil when another app activation
                // changes during this three-second probe, even though this alert is
                // still on screen. Testing visibility directly matches the promise
                // and avoids a focus-dependent false negative.
                self.persistentSelfTestPassed = alert.window.isVisible;
                NSTextField *badge = (NSTextField *)alert.accessoryView;
                if ([self.severity isEqual:@"critical"]) {
                    self.persistentSelfTestPassed = self.persistentSelfTestPassed
                        && [badge.textColor isEqual:NSColor.systemRedColor]
                        && [badge.stringValue containsString:@"重要"];
                }
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
            printf("{\"ok\":%s,\"visibleForSeconds\":3,\"severity\":\"%s\"}\n",
                   self.persistentSelfTestPassed ? "true" : "false", self.severity.UTF8String);
            fflush(stdout);
            [NSApp terminate:nil];
            return;
        }
        [self writeLog:[NSString stringWithFormat:@"persistent alert dismissed: %@", self.notificationTitle]];
        if (response == NSAlertSecondButtonReturn) {
            if (self.previewAction) [self showPlanPreview]; else [self showStatusPanel];
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
    NSURL *directory = [NSURL fileURLWithPath:[self dataDirectory]];
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

- (void)runLocalCommand:(NSArray<NSString *> *)command completion:(void (^)(NSDictionary *))completion {
    // Pass an argument array to our installed Node runtime, never a shell.
    // Keep subprocess work off the Cocoa main thread.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSString *plist = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/LaunchAgents/com.cjaxonj.codex-pulse.plist"];
        NSArray *args = [NSDictionary dictionaryWithContentsOfFile:plist][@"ProgramArguments"];
        NSString *node = args.count > 0 ? args[0] : nil;
        NSString *cli = [[self dataDirectory] stringByAppendingPathComponent:@"app/bin/codex-pulse.mjs"];
        if (self.previewSelfTest || self.settingsSelfTest) {
            node = NSProcessInfo.processInfo.environment[@"CODEX_PULSE_TEST_NODE"];
            cli = NSProcessInfo.processInfo.environment[@"CODEX_PULSE_TEST_CLI"];
        }
        NSDictionary *preview = nil;
        if (node.length && cli.length) {
            NSTask *task = [[NSTask alloc] init];
            task.executableURL = [NSURL fileURLWithPath:node];
            task.arguments = [@[cli] arrayByAddingObjectsFromArray:command];
            task.environment = NSProcessInfo.processInfo.environment;
            NSPipe *output = [NSPipe pipe];
            NSPipe *errors = [NSPipe pipe];
            task.standardOutput = output;
            task.standardError = errors;
            if ([task launchAndReturnError:nil]) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 25 * NSEC_PER_SEC), dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
                    if (task.running) [task terminate];
                });
                NSData *data = [output.fileHandleForReading readDataToEndOfFile];
                NSData *errorData = [errors.fileHandleForReading readDataToEndOfFile];
                [task waitUntilExit];
                if (task.terminationStatus != 0) data = errorData;
                id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                if ([parsed isKindOfClass:[NSDictionary class]]) preview = parsed;
            }
        }
        dispatch_async(dispatch_get_main_queue(), ^{ completion(preview); });
    });
}

- (void)showPlanPreview {
    // Preview never invokes Codex, a model, or a Goal mutation.
    [self runLocalCommand:@[@"preview"] completion:^(NSDictionary *preview) { [self presentPlanPreview:preview]; }];
}

- (void)presentPlanPreview:(NSDictionary *)preview {
    if (![preview[@"readOnly"] boolValue] || ![preview[@"tasks"] isKindOfClass:[NSArray class]]) preview = nil;
    NSArray *tasks = [preview[@"tasks"] isKindOfClass:[NSArray class]] ? preview[@"tasks"] : @[];
    NSMutableString *text = [NSMutableString string];
    if (!preview) [text appendString:@"暂时无法读取本机计划。请确认 Codex Pulse 已安装，再点击刷新。\n不会因此启动任何任务。"];
    else if (!tasks.count) [text appendString:@"当前没有待续跑的任务。\n到达保护线并保存检查点后，计划会显示在这里。"];
    for (NSDictionary *task in tasks) {
        if (text.length) [text appendString:@"\n\n────────────────────────\n\n"];
        NSDictionary *restart = task[@"restart"], *duration = task[@"duration"];
        NSString *time = restart[@"earliestAt"] ? [NSString stringWithFormat:@"最早额度恢复：%@\n", [self formatUnixTime:restart[@"earliestAt"]]] : @"";
        NSString *estimate = [duration[@"minMinutes"] isKindOfClass:[NSNumber class]]
          ? [NSString stringWithFormat:@"%@–%@ 分钟（低置信度）\n%@", duration[@"minMinutes"], duration[@"maxMinutes"], duration[@"source"]] : duration[@"source"];
        [text appendFormat:@"任务：%@\n状态：%@\n\n已完成\n%@\n\n剩余工作\n%@\n\n下一步\n%@\n\n启动时间\n%@%@\n\n剩余耗时\n%@\n\n需要注意\n%@\n\n检查点更新：%@",
          task[@"objective"], task[@"statusText"], task[@"completed"], task[@"remaining"], task[@"nextAction"], time, restart[@"text"], estimate, task[@"blockers"], [self formatUnixTime:task[@"updatedAt"]]];
    }
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"续跑计划";
    alert.informativeText = @"只读本机检查点，不启动任务，不额外消耗额度。";
    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(0, 0, 580, 380)];
    scroll.hasVerticalScroller = YES;
    NSTextView *view = [[NSTextView alloc] initWithFrame:scroll.bounds];
    view.editable = NO;
    view.selectable = YES;
    view.font = [NSFont systemFontOfSize:13];
    view.textContainerInset = NSMakeSize(12, 12);
    view.verticallyResizable = YES;
    view.autoresizingMask = NSViewWidthSizable;
    view.textContainer.widthTracksTextView = YES;
    view.string = text;
    scroll.documentView = view;
    alert.accessoryView = scroll;
    [alert addButtonWithTitle:@"关闭"];
    [alert addButtonWithTitle:@"刷新"];
    [alert addButtonWithTitle:@"查看状态"];
    [NSApp activateIgnoringOtherApps:YES];
    if (self.previewSelfTest) {
        NSTimer *timer = [NSTimer timerWithTimeInterval:2 repeats:NO block:^(NSTimer *timer) {
            BOOL ok = alert.window.isVisible && tasks.count == 2 && [view.string containsString:@"预览隔离任务"];
            NSString *capture = NSProcessInfo.processInfo.environment[@"CODEX_PULSE_TEST_CAPTURE"];
            if (capture.length) {
                NSView *content = alert.window.contentView;
                NSBitmapImageRep *bitmap = [content bitmapImageRepForCachingDisplayInRect:content.bounds];
                [content cacheDisplayInRect:content.bounds toBitmapImageRep:bitmap];
                [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:capture atomically:YES];
            }
            printf("{\"ok\":%s,\"tasks\":%lu,\"readOnly\":true}\n", ok ? "true" : "false", (unsigned long)tasks.count);
            fflush(stdout);
            [NSApp abortModal];
        }];
        [[NSRunLoop mainRunLoop] addTimer:timer forMode:NSModalPanelRunLoopMode];
    }
    NSModalResponse response = [alert runModal];
    [alert.window orderOut:nil];
    if (!self.previewSelfTest && response == NSAlertSecondButtonReturn) [self showPlanPreview];
    else if (!self.previewSelfTest && response == NSAlertThirdButtonReturn) [self showStatusPanel];
    else if (!self.settingsWindow) [NSApp terminate:nil];
}

- (void)showStatusPanel {
    if (!self.settingsWindow) {
        __weak CodexPulseDelegate *weakSelf = self;
        self.settingsWindow = [[PulseSettingsWindow alloc] initWithDataDirectory:[self dataDirectory]
            commandRunner:^(NSArray<NSString *> *arguments, void (^completion)(NSDictionary *)) {
                [weakSelf runLocalCommand:arguments completion:completion];
            } previewAction:^{ [weakSelf showPlanPreview]; }];
        if (self.settingsSelfTest) [self.settingsWindow runIsolatedSelfTest];
        [self.settingsWindow open];
    } else [self.settingsWindow showWindow:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    if (self.previewMode) { [self showPlanPreview]; return; }
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
        content.subtitle = [self severityLabel:self.severity];
        if (!self.silent) content.sound = [UNNotificationSound defaultSound];
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

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    if (!NSApp.modalWindow) [self showStatusPanel];
    return YES;
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
    completionHandler(UNNotificationPresentationOptionBanner | (self.silent ? 0 : UNNotificationPresentationOptionSound));
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
        delegate.settingsSelfTest = [arguments containsObject:@"--settings-self-test"];
        delegate.statusMode = arguments.count == 1 || [arguments containsObject:@"--status"] || [arguments containsObject:@"--settings"] || delegate.settingsSelfTest;
        delegate.silent = [arguments containsObject:@"--silent"];
        if (delegate.settingsSelfTest) app.appearance = [NSAppearance appearanceNamed:
            [NSProcessInfo.processInfo.environment[@"CODEX_PULSE_TEST_APPEARANCE"] isEqual:@"dark"] ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
        delegate.previewSelfTest = [arguments containsObject:@"--preview-self-test"];
        delegate.previewMode = [arguments containsObject:@"--preview"] || delegate.previewSelfTest;
        delegate.previewAction = [arguments containsObject:@"--preview-action"];
        NSUInteger severityIndex = [arguments indexOfObject:@"--severity"];
        delegate.severity = severityIndex != NSNotFound && severityIndex + 1 < arguments.count ? arguments[severityIndex + 1] : @"info";
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
