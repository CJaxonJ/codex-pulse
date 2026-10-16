#import <Cocoa/Cocoa.h>
#import <UserNotifications/UserNotifications.h>

@interface CodexPulseDelegate : NSObject <NSApplicationDelegate, UNUserNotificationCenterDelegate>
@property(nonatomic, copy) NSString *notificationTitle;
@property(nonatomic, copy) NSString *notificationBody;
@property(nonatomic, assign) BOOL setupMode;
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

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
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

    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    center.delegate = self;
    [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                          completionHandler:^(BOOL granted, NSError * _Nullable error) {
        if (error) {
            [self writeLog:[NSString stringWithFormat:@"authorization error: %@", error.localizedDescription]];
            if (self.setupMode) {
                [self showPermissionHelp:@"请在“系统设置 → 通知 → Codex Pulse”中打开“允许通知”。"];
            } else {
                [self finishAfterDelay];
            }
            return;
        }
        if (!granted) {
            [self writeLog:@"authorization denied"];
            if (self.setupMode) {
                [self showPermissionHelp:@"监控仍会运行，但不会弹出预警。可以稍后在系统通知设置中重新开启 Codex Pulse。"];
            } else {
                [self finishAfterDelay];
            }
            return;
        }

        UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
        content.title = self.notificationTitle;
        content.body = self.notificationBody;
        content.sound = [UNNotificationSound defaultSound];
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
            [self finishAfterDelay];
        }];
    }];
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
        delegate.notificationTitle = title;
        delegate.notificationBody = body;
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
