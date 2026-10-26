#import "PulseSettingsWindow.h"

@interface PulseFlippedView : NSView
@end
@implementation PulseFlippedView
- (BOOL)isFlipped { return YES; }
@end

@interface PulseSettingsWindow ()
@property(copy) NSString *directory;
@property(copy) PulseCommandRunner runner;
@property(copy) dispatch_block_t preview;
@property(copy) dispatch_block_t protection;
@property(strong) NSMutableDictionary<NSString *, NSSwitch *> *switches;
@property(strong) NSSlider *threshold;
@property(strong) NSTextField *thresholdLabel;
@property(strong) NSPopUpButton *policy;
@property(strong) NSButton *saveButton;
@property(strong) NSTextField *feedback;
@property(strong) NSTextField *health;
@property(strong) NSTextField *quotaText;
@property(strong) NSTextField *weeklyText;
@property(strong) NSTextField *resetText;
@property(strong) NSTextField *recentText;
@property(strong) NSSwitch *creditSwitch;
@property(strong) NSScrollView *scroll;
@property(copy) NSDictionary *saved;
@property(assign) BOOL loading;
@property(assign) BOOL saving;
@property(assign) BOOL creditBusy;
@property(assign) BOOL creditEnabled;
@property(copy) dispatch_block_t afterSave;
@property(copy) dispatch_block_t afterLoad;
@property(copy) void (^afterCreditChange)(BOOL);
@end

@implementation PulseSettingsWindow

- (NSColor *)green { return [NSColor colorWithRed:0.18 green:0.52 blue:0.46 alpha:1]; }
- (NSDictionary *)readJSON:(NSString *)file {
    NSData *data = [NSData dataWithContentsOfFile:[self.directory stringByAppendingPathComponent:file]];
    id value = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    return [value isKindOfClass:NSDictionary.class] ? value : @{};
}
- (NSTextField *)label:(NSString *)text frame:(NSRect)frame size:(CGFloat)size weight:(NSFontWeight)weight parent:(NSView *)parent {
    NSTextField *label = [NSTextField wrappingLabelWithString:text ?: @""];
    label.frame = frame;
    label.font = [NSFont systemFontOfSize:size weight:weight];
    label.textColor = NSColor.labelColor;
    [parent addSubview:label];
    return label;
}
- (NSView *)cardAt:(CGFloat)y height:(CGFloat)height parent:(NSView *)parent {
    NSView *view = [[PulseFlippedView alloc] initWithFrame:NSMakeRect(0, y, 604, height)];
    view.wantsLayer = YES;
    view.layer.backgroundColor = NSColor.controlBackgroundColor.CGColor;
    view.layer.cornerRadius = 12;
    view.layer.borderWidth = 0.5;
    view.layer.borderColor = [NSColor.separatorColor colorWithAlphaComponent:0.45].CGColor;
    [parent addSubview:view];
    return view;
}
- (void)section:(NSString *)title at:(CGFloat)y parent:(NSView *)parent {
    [self label:title frame:NSMakeRect(2, y, 580, 22) size:12 weight:NSFontWeightSemibold parent:parent].textColor = NSColor.secondaryLabelColor;
}
- (NSSwitch *)row:(NSString *)title detail:(NSString *)detail key:(NSString *)key at:(CGFloat)y parent:(NSView *)parent {
    [self label:title frame:NSMakeRect(18, y + 10, 485, 21) size:13 weight:NSFontWeightMedium parent:parent];
    [self label:detail frame:NSMakeRect(18, y + 32, 485, 22) size:11 weight:NSFontWeightRegular parent:parent].textColor = NSColor.secondaryLabelColor;
    NSSwitch *control = [[NSSwitch alloc] initWithFrame:NSMakeRect(544, y + 17, 40, 25)];
    control.controlSize = NSControlSizeSmall;
    control.target = self;
    control.action = @selector(changed:);
    control.accessibilityLabel = title;
    [parent addSubview:control];
    if (key) self.switches[key] = control;
    return control;
}
- (void)separatorAt:(CGFloat)y parent:(NSView *)parent {
    NSBox *line = [[NSBox alloc] initWithFrame:NSMakeRect(18, y, 568, 1)];
    line.boxType = NSBoxSeparator;
    [parent addSubview:line];
}
- (instancetype)initWithDataDirectory:(NSString *)directory commandRunner:(PulseCommandRunner)runner previewAction:(dispatch_block_t)preview protectionAction:(dispatch_block_t)protectionAction {
    CGFloat visibleHeight = NSScreen.mainScreen.visibleFrame.size.height;
    CGFloat height = MIN(842, MAX(550, visibleHeight - 90));
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 660, height)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
        backing:NSBackingStoreBuffered defer:NO];
    self = [super initWithWindow:window];
    if (!self) return nil;
    self.directory = directory; self.runner = runner; self.preview = preview; self.protection=protectionAction;
    self.switches = [NSMutableDictionary dictionary];
    window.title = @"Codex Pulse";
    window.delegate = self;
    window.releasedWhenClosed = NO;
    window.backgroundColor = NSColor.windowBackgroundColor;
    PulseFlippedView *root = [[PulseFlippedView alloc] initWithFrame:NSMakeRect(0, 0, 660, height)];
    root.wantsLayer = YES;
    root.layer.backgroundColor = NSColor.windowBackgroundColor.CGColor;
    window.contentView = root;
    NSImageView *icon = [[NSImageView alloc] initWithFrame:NSMakeRect(26, 22, 44, 44)];
    icon.image = [NSImage imageNamed:NSImageNameApplicationIcon];
    [root addSubview:icon];
    [self label:@"Codex Pulse" frame:NSMakeRect(82, 21, 350, 30) size:23 weight:NSFontWeightSemibold parent:root];
    [self label:@"额度保护与提醒，按你的习惯来。" frame:NSMakeRect(83, 53, 390, 21) size:12 weight:NSFontWeightRegular parent:root].textColor = NSColor.secondaryLabelColor;
    self.health = [self label:@"读取本机状态…" frame:NSMakeRect(475, 35, 158, 21) size:11 weight:NSFontWeightMedium parent:root];
    self.health.alignment = NSTextAlignmentRight;

    self.scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(28, 94, 616, height - 170)];
    self.scroll.hasVerticalScroller = YES; self.scroll.autohidesScrollers = NO;
    self.scroll.drawsBackground = NO;
    PulseFlippedView *body = [[PulseFlippedView alloc] initWithFrame:NSMakeRect(0, 0, 604, 826)];
    self.scroll.documentView = body;
    [root addSubview:self.scroll];
    NSView *quota = [self cardAt:0 height:116 parent:body];
    [self label:@"5 小时剩余" frame:NSMakeRect(18, 14, 142, 18) size:11 weight:NSFontWeightRegular parent:quota].textColor = NSColor.secondaryLabelColor;
    self.quotaText = [self label:@"—" frame:NSMakeRect(18, 36, 145, 35) size:25 weight:NSFontWeightSemibold parent:quota];
    [self label:@"本周剩余" frame:NSMakeRect(206, 14, 142, 18) size:11 weight:NSFontWeightRegular parent:quota].textColor = NSColor.secondaryLabelColor;
    self.weeklyText = [self label:@"—" frame:NSMakeRect(206, 36, 145, 35) size:25 weight:NSFontWeightSemibold parent:quota];
    [self label:@"个人窗口恢复" frame:NSMakeRect(394, 14, 180, 18) size:11 weight:NSFontWeightRegular parent:quota].textColor = NSColor.secondaryLabelColor;
    self.resetText = [self label:@"待确认" frame:NSMakeRect(394, 43, 190, 30) size:14 weight:NSFontWeightMedium parent:quota];
    self.recentText = [self label:@"最近还没有关键提醒" frame:NSMakeRect(18, 88, 566, 18) size:10 weight:NSFontWeightRegular parent:quota];
    self.recentText.maximumNumberOfLines = 1;
    self.recentText.lineBreakMode = NSLineBreakByTruncatingTail;

    [self section:@"额度保护" at:138 parent:body];
    NSView *protection = [self cardAt:164 height:76 parent:body];
    [self label:@"保护策略" frame:NSMakeRect(18, 12, 280, 21) size:13 weight:NSFontWeightMedium parent:protection];
    [self label:@"提醒开关不改变暂停、检查点与安全校验。" frame:NSMakeRect(18, 38, 330, 26) size:11 weight:NSFontWeightRegular parent:protection].textColor = NSColor.secondaryLabelColor;
    self.policy = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(362, 22, 224, 28) pullsDown:NO];
    [self.policy addItemsWithTitles:@[@"10% 安全暂停（推荐）", @"优先完成当前结果", @"截止时间优先"]];
    self.policy.target = self; self.policy.action = @selector(changed:);
    self.policy.accessibilityLabel = @"保护策略";
    [protection addSubview:self.policy];

    [self section:@"提醒偏好" at:262 parent:body];
    NSView *notices = [self cardAt:288 height:370 parent:body];
    [self row:@"额度提前提醒" detail:@"低于设定比例或消耗过快时提醒；10% 保护提醒始终保留。" key:@"quotaAlertsEnabled" at:0 parent:notices];
    [self label:@"提醒比例" frame:NSMakeRect(18, 76, 85, 22) size:12 weight:NSFontWeightRegular parent:notices].textColor = NSColor.secondaryLabelColor;
    self.threshold = [[NSSlider alloc] initWithFrame:NSMakeRect(112, 74, 400, 24)];
    self.threshold.minValue = 15; self.threshold.maxValue = 80;
    self.threshold.continuous = YES; self.threshold.target = self; self.threshold.action = @selector(changed:);
    self.threshold.accessibilityLabel = @"提前提醒的剩余额度百分比";
    [notices addSubview:self.threshold];
    self.thresholdLabel = [self label:@"20%" frame:NSMakeRect(527, 75, 58, 22) size:13 weight:NSFontWeightSemibold parent:notices];
    self.thresholdLabel.alignment = NSTextAlignmentRight;
    [self separatorAt:112 parent:notices];
    [self row:@"公共重置信号" detail:@"监控 Tibo 公开动态；关闭后个人额度仍照常监控。" key:@"tiboEnabled" at:114 parent:notices];
    [self separatorAt:176 parent:notices];
    [self row:@"重置卡到期提醒" detail:@"仅控制到期提醒，不会关闭下方已授权的自动用卡。" key:@"creditAlertsEnabled" at:178 parent:notices];
    [self separatorAt:240 parent:notices];
    [self row:@"重要提醒保持可见" detail:@"开启时窗口保留至手动关闭；关闭后仅发系统通知。" key:@"persistentAlertsEnabled" at:242 parent:notices];
    [self separatorAt:304 parent:notices];
    [self row:@"通知声音" detail:@"关闭声音不影响通知和安全保护。" key:@"soundEnabled" at:306 parent:notices];

    [self section:@"临期卡自动使用" at:680 parent:body];
    NSView *credits = [self cardAt:706 height:86 parent:body];
    self.creditSwitch = [self row:@"自动挽救临期卡" detail:@"不足 10 分钟且额度可重置才使用一张；仅限授权个人账户。" key:nil at:0 parent:credits];
    self.creditSwitch.action = @selector(creditChanged:);
    [self label:@"单独授权，即时生效。睡眠或断网可能错过到期。" frame:NSMakeRect(18, 61, 556, 18) size:10 weight:NSFontWeightRegular parent:credits].textColor = NSColor.secondaryLabelColor;
    [self label:@"设置仅保存在这台 Mac，不修改 Hook 信任或系统通知权限。" frame:NSMakeRect(2, 806, 600, 18) size:10 weight:NSFontWeightRegular parent:body].textColor = NSColor.tertiaryLabelColor;

    NSButton *plan = [NSButton buttonWithTitle:@"续跑计划" target:self action:@selector(openPreview:)];
    plan.frame = NSMakeRect(28, height - 53, 90, 29); [root addSubview:plan];
    NSButton *system = [NSButton buttonWithTitle:@"系统通知设置" target:self action:@selector(openSystem:)];
    system.frame = NSMakeRect(126, height - 53, 118, 29); [root addSubview:system];
    NSButton *authorization=[NSButton buttonWithTitle:@"保护授权" target:self action:@selector(openProtection:)];
    authorization.frame=NSMakeRect(252,height-53,86,29); [root addSubview:authorization];
    self.feedback = [self label:@"正在读取设置…" frame:NSMakeRect(345, height - 48, 175, 22) size:11 weight:NSFontWeightRegular parent:root];
    self.feedback.textColor = NSColor.secondaryLabelColor;
    self.saveButton = [NSButton buttonWithTitle:@"保存更改" target:self action:@selector(save:)];
    self.saveButton.frame = NSMakeRect(530, height - 54, 102, 32);
    self.saveButton.bezelStyle = NSBezelStyleRounded;
    self.saveButton.bezelColor = self.green;
    self.saveButton.contentTintColor = NSColor.whiteColor;
    self.saveButton.keyEquivalent = @"s";
    self.saveButton.keyEquivalentModifierMask = NSEventModifierFlagCommand;
    [root addSubview:self.saveButton];
    [self refreshQuota];
    return self;
}
- (void)refreshQuota {
    NSDictionary *state = [self readJSON:@"state.json"];
    NSDictionary *summary = [state[@"lastSummary"] isKindOfClass:NSDictionary.class] ? state[@"lastSummary"] : @{};
    NSDictionary *five = [summary[@"fiveHour"] isKindOfClass:NSDictionary.class] ? summary[@"fiveHour"] : @{};
    NSDictionary *weekly = [summary[@"weekly"] isKindOfClass:NSDictionary.class] ? summary[@"weekly"] : @{};
    self.quotaText.stringValue = [five[@"remainingPercent"] isKindOfClass:NSNumber.class] ? [NSString stringWithFormat:@"%@%%", five[@"remainingPercent"]] : @"未提供";
    self.weeklyText.stringValue = [weekly[@"remainingPercent"] isKindOfClass:NSNumber.class] ? [NSString stringWithFormat:@"%@%%", weekly[@"remainingPercent"]] : @"暂不可用";
    NSDateFormatter *format = [[NSDateFormatter alloc] init]; format.dateFormat = @"M月d日 HH:mm";
    self.resetText.stringValue = [five[@"resetsAt"] isKindOfClass:NSNumber.class] ? [format stringFromDate:[NSDate dateWithTimeIntervalSince1970:[five[@"resetsAt"] doubleValue]]] : @"以官方窗口为准";
    NSDictionary *sample = [state[@"fiveHour"] isKindOfClass:NSDictionary.class] ? state[@"fiveHour"] : @{};
    NSNumber *stamp = [state[@"quotaCheckedAt"] isKindOfClass:NSNumber.class] ? state[@"quotaCheckedAt"] : sample[@"lastCheckedAt"];
    NSTimeInterval age = [stamp isKindOfClass:NSNumber.class] ? NSDate.date.timeIntervalSince1970 - stamp.doubleValue : INFINITY;
    BOOL fresh = age >= -30 && age < 180;
    self.health.stringValue = fresh ? @"● 额度刚刚更新" : @"○ 等待额度更新";
    self.health.textColor = fresh ? self.green : NSColor.secondaryLabelColor;
    NSDictionary *journal = [self readJSON:@"user-events.json"];
    NSArray *events = [journal[@"events"] isKindOfClass:NSArray.class] ? journal[@"events"] : @[];
    NSDictionary *latest = [events.lastObject isKindOfClass:NSDictionary.class] ? events.lastObject : @{};
    NSString *title = [latest[@"title"] isKindOfClass:NSString.class] ? latest[@"title"] : @"";
    self.recentText.stringValue = title.length ? [@"最近 · " stringByAppendingString:title] : @"最近还没有关键提醒";
    self.recentText.toolTip = [latest[@"body"] isKindOfClass:NSString.class] ? latest[@"body"] : nil;
    self.recentText.textColor = [latest[@"severity"] isEqual:@"critical"] ? NSColor.systemRedColor
        : [latest[@"severity"] isEqual:@"warning"] ? NSColor.systemOrangeColor : NSColor.secondaryLabelColor;
}
- (NSDictionary *)draft {
    NSMutableDictionary *value = [NSMutableDictionary dictionary];
    for (NSString *key in self.switches) value[key] = [NSNumber numberWithBool:self.switches[key].state == NSControlStateValueOn];
    value[@"quotaPolicy"] = @[@"strict_reserve", @"finish_current", @"deadline"][self.policy.indexOfSelectedItem];
    value[@"lowQuotaPercent"] = @((NSInteger)llround(self.threshold.doubleValue));
    return value;
}
- (void)setEditingEnabled:(BOOL)enabled {
    self.policy.enabled = enabled;
    for (NSSwitch *control in self.switches.allValues) control.enabled = enabled;
    self.threshold.enabled = enabled && self.switches[@"quotaAlertsEnabled"].state == NSControlStateValueOn;
    self.creditSwitch.enabled = enabled && !self.creditBusy;
    self.saveButton.enabled = enabled && ![[self draft] isEqual:self.saved];
}
- (void)loadSettings {
    self.loading = YES;
    [self setEditingEnabled:NO];
    self.runner(@[@"settings"], ^(NSDictionary *result) {
        self.loading = NO;
        if (![result[@"ok"] boolValue] || ![result[@"settings"] isKindOfClass:NSDictionary.class]) {
            self.feedback.stringValue = @"读取失败，请重新打开窗口";
            self.feedback.textColor = NSColor.systemRedColor;
            return;
        }
        self.saved = result[@"settings"];
        for (NSString *key in self.switches) self.switches[key].state = [self.saved[key] boolValue] ? NSControlStateValueOn : NSControlStateValueOff;
        NSInteger index = [@[@"strict_reserve", @"finish_current", @"deadline"] indexOfObject:self.saved[@"quotaPolicy"]];
        [self.policy selectItemAtIndex:index == NSNotFound ? 0 : index];
        self.threshold.doubleValue = [self.saved[@"lowQuotaPercent"] doubleValue];
        self.thresholdLabel.stringValue = [NSString stringWithFormat:@"%.0f%%", self.threshold.doubleValue];
        self.creditEnabled = [result[@"autoRedeemEnabled"] boolValue];
        self.creditSwitch.state = self.creditEnabled ? NSControlStateValueOn : NSControlStateValueOff;
        [self setEditingEnabled:YES];
        self.feedback.stringValue = @"更改后点击保存";
        if (self.afterLoad) { dispatch_block_t block = self.afterLoad; self.afterLoad = nil; block(); }
    });
}
- (void)open {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [self.window center]; [self showWindow:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [self loadSettings];
    __weak PulseSettingsWindow *weakSelf = self;
    [NSTimer scheduledTimerWithTimeInterval:60 repeats:YES block:^(NSTimer *timer) { [weakSelf refreshQuota]; }];
}
- (void)changed:(id)sender {
    self.threshold.doubleValue = llround(self.threshold.doubleValue);
    self.thresholdLabel.stringValue = [NSString stringWithFormat:@"%.0f%%", self.threshold.doubleValue];
    [self setEditingEnabled:!self.loading && !self.saving];
    self.feedback.stringValue = [[self draft] isEqual:self.saved] ? @"更改后点击保存" : @"有尚未保存的更改";
    self.feedback.textColor = NSColor.secondaryLabelColor;
}
- (void)save:(id)sender {
    if (self.loading || self.saving || !self.saved) return;
    NSDictionary *patch = [self draft];
    if (![patch[@"quotaPolicy"] isEqual:@"strict_reserve"] && ![patch[@"quotaPolicy"] isEqual:self.saved[@"quotaPolicy"]]) {
        NSAlert *confirm = [[NSAlert alloc] init];
        confirm.messageText = @"更改额度保护策略？";
        confirm.informativeText = @"这会允许当前结果继续使用保护区额度。若希望在 10% 时暂停并保存检查点，请保留推荐策略。";
        [confirm addButtonWithTitle:@"更改策略"]; [confirm addButtonWithTitle:@"保留原设置"];
        if ([confirm runModal] != NSAlertFirstButtonReturn) return;
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:patch options:0 error:nil];
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    self.saving = YES; [self setEditingEnabled:NO];
    self.feedback.stringValue = @"正在保存…";
    self.runner(@[@"settings", @"--update", json], ^(NSDictionary *result) {
        self.saving = NO;
        if ([result[@"ok"] boolValue]) {
            self.saved = result[@"settings"];
            self.feedback.stringValue = @"已保存 · 下轮检查生效";
            self.feedback.textColor = self.green;
        } else {
            self.feedback.stringValue = @"保存失败，请重试";
            self.feedback.toolTip = result[@"error"] ?: @"本机设置暂不可用";
            self.feedback.textColor = NSColor.systemRedColor;
        }
        [self setEditingEnabled:YES];
        if (self.afterSave) { dispatch_block_t block = self.afterSave; self.afterSave = nil; block(); }
    });
}
- (void)creditChanged:(NSSwitch *)sender {
    if (self.creditBusy) return;
    BOOL requested = sender.state == NSControlStateValueOn;
    sender.state = self.creditEnabled ? NSControlStateValueOn : NSControlStateValueOff;
    if (requested) {
        NSAlert *confirm = [[NSAlert alloc] init];
        confirm.messageText = @"允许为当前个人账户自动用卡？";
        confirm.informativeText = @"卡不足 10 分钟到期、且有额度可重置时，会使用最早到期的一张。这可能真实消费卡片；不会购买或切换账户。睡眠、离线可能错过到期。可随时关闭。";
        [confirm addButtonWithTitle:@"同意并开启"]; [confirm addButtonWithTitle:@"暂不开启"];
        if ([confirm runModal] != NSAlertFirstButtonReturn) return;
    }
    self.creditBusy = YES; [self setEditingEnabled:!self.loading && !self.saving];
    self.feedback.stringValue = requested ? @"正在核对账户授权…" : @"正在关闭自动用卡…";
    self.runner(requested ? @[@"credits-policy", @"--enable", @"--yes"] : @[@"credits-policy", @"--disable"], ^(NSDictionary *result) {
        self.creditBusy = NO;
        if ([result[@"ok"] boolValue]) {
            self.creditEnabled = [result[@"enabled"] boolValue];
            sender.state = self.creditEnabled ? NSControlStateValueOn : NSControlStateValueOff;
            self.feedback.stringValue = self.creditEnabled ? @"自动用卡已授权" : @"自动用卡已关闭";
            self.feedback.textColor = self.green;
        } else { self.feedback.stringValue = @"用卡设置未更改"; self.feedback.toolTip = result[@"error"]; self.feedback.textColor = NSColor.systemRedColor; }
        [self setEditingEnabled:!self.loading && !self.saving];
        if (self.afterCreditChange) {
            void (^block)(BOOL) = self.afterCreditChange;
            self.afterCreditChange = nil;
            block([result[@"ok"] boolValue]);
        }
    });
}
- (void)openPreview:(id)sender { if (self.preview) self.preview(); }
- (void)openProtection:(id)sender { if(self.protection) self.protection(); }
- (void)openSystem:(id)sender {
    [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.Notifications-Settings.extension"]];
}
- (BOOL)windowShouldClose:(NSWindow *)sender {
    if (self.saving || self.creditBusy) { self.feedback.stringValue = @"正在保存，请稍候"; return NO; }
    if (!self.saved || [[self draft] isEqual:self.saved]) return YES;
    NSAlert *alert = [[NSAlert alloc] init]; alert.messageText = @"还有未保存的更改";
    alert.informativeText = @"关闭后将保留原有设置。临期自动用卡的单独授权不受影响。";
    [alert addButtonWithTitle:@"继续编辑"]; [alert addButtonWithTitle:@"放弃更改"];
    return [alert runModal] == NSAlertSecondButtonReturn;
}
- (void)windowWillClose:(NSNotification *)notification {
    for(NSWindow *window in NSApp.windows) if(window!=self.window && window.isVisible) return;
    [NSApp terminate:nil];
}

- (void)capture:(NSString *)name {
    NSString *root = NSProcessInfo.processInfo.environment[@"CODEX_PULSE_TEST_CAPTURE_DIR"];
    if (!root.length) return;
    NSView *view = self.window.contentView;
    NSBitmapImageRep *bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
    [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[root stringByAppendingPathComponent:name] atomically:YES];
}
- (void)runIsolatedSelfTest {
    __weak PulseSettingsWindow *weakSelf = self;
    self.afterLoad = ^{
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            PulseSettingsWindow *view = weakSelf;
            [view capture:@"settings.png"];
            view.threshold.doubleValue = 35;
            view.switches[@"soundEnabled"].state = NSControlStateValueOff;
            view.switches[@"persistentAlertsEnabled"].state = NSControlStateValueOff;
            [NSApp sendAction:view.threshold.action to:view.threshold.target from:view.threshold];
            view.afterSave = ^{
                PulseSettingsWindow *current = weakSelf;
                NSDictionary *saved = [current readJSON:@"preferences.json"];
                BOOL ok = current.window.isVisible && [saved[@"lowQuotaPercent"] integerValue] == 35
                    && ![saved[@"soundEnabled"] boolValue] && ![saved[@"persistentAlertsEnabled"] boolValue]
                    && [saved[@"autoRedeem"][@"enabled"] boolValue] && !current.saveButton.enabled;
                [current capture:@"settings-saved.png"];
                [current.scroll.documentView scrollPoint:NSMakePoint(0, current.scroll.documentView.bounds.size.height)];
                [current capture:@"settings-bottom.png"];
                current.afterCreditChange = ^(BOOL saved) {
                    PulseSettingsWindow *finalView = weakSelf;
                    NSDictionary *finalPreferences = [finalView readJSON:@"preferences.json"];
                    BOOL disabled = saved && ![finalPreferences[@"autoRedeem"][@"enabled"] boolValue]
                        && finalView.creditSwitch.state == NSControlStateValueOff;
                    [finalView capture:@"settings-credit-off.png"];
                    printf("{\"ok\":%s,\"regularSavePreservedConsent\":%s,\"explicitDisableWorked\":%s}\n",
                        ok && disabled ? "true" : "false", ok ? "true" : "false", disabled ? "true" : "false");
                    fflush(stdout); [NSApp terminate:nil];
                };
                current.creditSwitch.state = NSControlStateValueOff;
                [NSApp sendAction:current.creditSwitch.action to:current.creditSwitch.target from:current.creditSwitch];
            };
            [view.saveButton performClick:nil];
        });
    };
}
@end
