#import "PulseSettingsWindow.h"
#import "PulsePostLink.h"

@interface PulseFlippedView : NSView
@end
@implementation PulseFlippedView
- (BOOL)isFlipped { return YES; }
@end

// Quota is a measured value, not a decorative chart. Unknown values have no fill.
@interface PulseQuotaBar : NSView
@property(strong) NSNumber *remaining;
@property(strong) NSColor *accent;
@end
@implementation PulseQuotaBar
- (BOOL)isFlipped { return YES; }
- (void)drawRect:(NSRect)dirtyRect {
    [[NSColor.separatorColor colorWithAlphaComponent:0.3] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:self.bounds xRadius:2 yRadius:2] fill];
    if (!self.remaining) return;
    CGFloat fraction = MIN(1, MAX(0, self.remaining.doubleValue / 100));
    NSRect fill = self.bounds; fill.size.width *= fraction;
    [self.accent setFill];
    [[NSBezierPath bezierPathWithRoundedRect:fill xRadius:2 yRadius:2] fill];
}
@end

@interface PulseSettingsWindow () <NSTableViewDataSource, NSTableViewDelegate>
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
@property(strong) PulseQuotaBar *quotaBar;
@property(strong) PulseQuotaBar *weeklyBar;
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
@property(strong) NSWindow *tiboWindow;
@property(strong) NSButton *tiboHistoryButton;
@property(strong) NSPopover *tiboHistory;
@property(strong) NSTableView *tiboTable;
@property(assign) NSInteger selectedTiboIndex;
@property(strong) NSTextField *tiboStatus;
@property(strong) NSTextField *tiboStatusNote;
@property(strong) NSTextField *tiboSelection;
@property(strong) NSTextField *tiboMetadata;
@property(strong) NSTextField *tiboTiming;
@property(strong) NSTextField *tiboFeedback;
@property(strong) NSTextView *tiboDetail;
@property(strong) NSButton *tiboSourceButton;
@property(strong) NSButton *tiboParentButton;
@property(nonatomic, copy) NSArray<NSDictionary *> *tiboEvents;
@property(copy) BOOL (^sourceOpener)(NSURL *);
@end

@implementation PulseSettingsWindow

- (NSColor *)green { return [NSColor colorWithRed:0.18 green:0.52 blue:0.46 alpha:1]; }
- (void)setTiboEvents:(NSArray<NSDictionary *> *)events {
    _tiboEvents = [events copy];
    [self.tiboTable reloadData];
}
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
    NSView *view = [[PulseFlippedView alloc] initWithFrame:NSMakeRect(0, y, 640, height)];
    view.wantsLayer = YES;
    view.layer.backgroundColor = NSColor.controlBackgroundColor.CGColor;
    view.layer.cornerRadius = 16;
    [parent addSubview:view];
    return view;
}
- (void)section:(NSString *)title at:(CGFloat)y parent:(NSView *)parent {
    [self label:title frame:NSMakeRect(0, y, 640, 24) size:14 weight:NSFontWeightSemibold parent:parent];
}
- (NSSwitch *)row:(NSString *)title detail:(NSString *)detail key:(NSString *)key at:(CGFloat)y parent:(NSView *)parent {
    [self label:title frame:NSMakeRect(24, y + 12, 520, 24) size:14 weight:NSFontWeightMedium parent:parent];
    [self label:detail frame:NSMakeRect(24, y + 40, 520, 24) size:12 weight:NSFontWeightRegular parent:parent].textColor = NSColor.secondaryLabelColor;
    NSSwitch *control = [[NSSwitch alloc] initWithFrame:NSMakeRect(576, y + 24, 40, 24)];
    control.controlSize = NSControlSizeSmall;
    control.target = self;
    control.action = @selector(changed:);
    control.accessibilityLabel = title;
    [parent addSubview:control];
    if (key) self.switches[key] = control;
    return control;
}
- (void)separatorAt:(CGFloat)y parent:(NSView *)parent {
    NSBox *line = [[NSBox alloc] initWithFrame:NSMakeRect(24, y, 592, 1)];
    line.boxType = NSBoxSeparator;
    [parent addSubview:line];
}
- (instancetype)initWithDataDirectory:(NSString *)directory commandRunner:(PulseCommandRunner)runner previewAction:(dispatch_block_t)preview protectionAction:(dispatch_block_t)protectionAction {
    CGFloat visibleHeight = NSScreen.mainScreen.visibleFrame.size.height;
    CGFloat height = MIN(842, MAX(550, visibleHeight - 90));
    // Only the isolated self-test may constrain the window to a small display.
    if ([NSProcessInfo.processInfo.arguments containsObject:@"--settings-self-test"]
        && [NSProcessInfo.processInfo.environment[@"CODEX_PULSE_TEST_COMPACT"] boolValue]) height = 550;
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 720, height)
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
    PulseFlippedView *root = [[PulseFlippedView alloc] initWithFrame:NSMakeRect(0, 0, 720, height)];
    root.wantsLayer = YES;
    root.layer.backgroundColor = NSColor.windowBackgroundColor.CGColor;
    window.contentView = root;
    NSImageView *icon = [[NSImageView alloc] initWithFrame:NSMakeRect(32, 24, 48, 48)];
    icon.image = [NSImage imageNamed:NSImageNameApplicationIcon];
    [root addSubview:icon];
    [self label:@"Codex Pulse" frame:NSMakeRect(96, 24, 320, 32) size:24 weight:NSFontWeightSemibold parent:root];
    [self label:@"掌握剩余额度，安排下一步。" frame:NSMakeRect(96, 60, 320, 24) size:12 weight:NSFontWeightRegular parent:root].textColor = NSColor.secondaryLabelColor;
    self.health = [self label:@"读取本机状态…" frame:NSMakeRect(472, 40, 200, 24) size:12 weight:NSFontWeightMedium parent:root];
    self.health.alignment = NSTextAlignmentRight;

    self.scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(32, 104, 656, height - 184)];
    self.scroll.hasVerticalScroller = YES; self.scroll.autohidesScrollers = YES;
    self.scroll.drawsBackground = NO;
    PulseFlippedView *body = [[PulseFlippedView alloc] initWithFrame:NSMakeRect(0, 0, 640, 1040)];
    self.scroll.documentView = body;
    [root addSubview:self.scroll];
    NSView *quota = [self cardAt:0 height:192 parent:body];
    // Equal columns share one metric type size and the same vertical anchors.
    const CGFloat metricWidth = 280, metricY = 40, barY = 96, metricSize = 30;
    [self label:@"5 小时剩余" frame:NSMakeRect(24, 16, metricWidth, 24) size:12 weight:NSFontWeightMedium parent:quota].textColor = NSColor.secondaryLabelColor;
    self.quotaText = [self label:@"—" frame:NSMakeRect(24, metricY, metricWidth, 40) size:metricSize weight:NSFontWeightSemibold parent:quota];
    self.quotaText.font = [NSFont monospacedDigitSystemFontOfSize:metricSize weight:NSFontWeightSemibold];
    self.quotaBar = [[PulseQuotaBar alloc] initWithFrame:NSMakeRect(24, barY, metricWidth, 4)];
    [quota addSubview:self.quotaBar];
    [self label:@"本周剩余" frame:NSMakeRect(336, 16, metricWidth, 24) size:12 weight:NSFontWeightMedium parent:quota].textColor = NSColor.secondaryLabelColor;
    self.weeklyText = [self label:@"—" frame:NSMakeRect(336, metricY, metricWidth, 40) size:metricSize weight:NSFontWeightSemibold parent:quota];
    self.weeklyText.font = self.quotaText.font;
    self.weeklyBar = [[PulseQuotaBar alloc] initWithFrame:NSMakeRect(336, barY, metricWidth, 4)];
    [quota addSubview:self.weeklyBar];
    [self label:@"5 小时窗口恢复" frame:NSMakeRect(24, 120, 168, 24) size:14 weight:NSFontWeightRegular parent:quota].textColor = NSColor.secondaryLabelColor;
    self.resetText = [self label:@"待确认" frame:NSMakeRect(208, 120, 408, 24) size:14 weight:NSFontWeightMedium parent:quota];
    self.recentText = [self label:@"暂无关键提醒" frame:NSMakeRect(24, 152, 448, 24) size:12 weight:NSFontWeightRegular parent:quota];
    self.recentText.maximumNumberOfLines = 1;
    self.recentText.lineBreakMode = NSLineBreakByTruncatingTail;
    NSButton *tibo = [NSButton buttonWithTitle:@"Tibo 动态" target:self action:@selector(openTibo:)];
    tibo.frame = NSMakeRect(488, 148, 128, 32);
    tibo.font = [NSFont systemFontOfSize:14 weight:NSFontWeightMedium];
    [quota addSubview:tibo];

    [self section:@"额度保护" at:216 parent:body];
    NSView *protection = [self cardAt:248 height:88 parent:body];
    [self label:@"保护策略" frame:NSMakeRect(24, 16, 280, 24) size:14 weight:NSFontWeightMedium parent:protection];
    [self label:@"提醒可关闭，安全校验始终保留。" frame:NSMakeRect(24, 48, 320, 24) size:12 weight:NSFontWeightRegular parent:protection].textColor = NSColor.secondaryLabelColor;
    self.policy = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(368, 24, 248, 32) pullsDown:NO];
    self.policy.font = [NSFont systemFontOfSize:14 weight:NSFontWeightMedium];
    [self.policy addItemsWithTitles:@[@"10% 安全暂停（推荐）", @"优先完成当前结果", @"截止时间优先"]];
    self.policy.target = self; self.policy.action = @selector(changed:);
    self.policy.accessibilityLabel = @"保护策略";
    [protection addSubview:self.policy];

    [self section:@"提醒偏好" at:360 parent:body];
    NSView *notices = [self cardAt:392 height:416 parent:body];
    [self row:@"提前提醒我" detail:@"低于设定比例或用量消耗过快时提醒。10% 保护提醒始终保留。" key:@"quotaAlertsEnabled" at:0 parent:notices];
    [self label:@"剩余额度低于" frame:NSMakeRect(24, 80, 112, 24) size:12 weight:NSFontWeightRegular parent:notices].textColor = NSColor.secondaryLabelColor;
    self.threshold = [[NSSlider alloc] initWithFrame:NSMakeRect(144, 80, 392, 24)];
    self.threshold.minValue = 15; self.threshold.maxValue = 80;
    self.threshold.continuous = YES; self.threshold.target = self; self.threshold.action = @selector(changed:);
    self.threshold.accessibilityLabel = @"提前提醒的剩余额度百分比";
    [notices addSubview:self.threshold];
    self.thresholdLabel = [self label:@"20%" frame:NSMakeRect(552, 80, 64, 24) size:14 weight:NSFontWeightSemibold parent:notices];
    self.thresholdLabel.font = [NSFont monospacedDigitSystemFontOfSize:14 weight:NSFontWeightSemibold];
    self.thresholdLabel.alignment = NSTextAlignmentRight;
    [self separatorAt:120 parent:notices];
    [self row:@"Tibo 重置动态" detail:@"收到公开重置信号时提醒；个人额度独立监控。" key:@"tiboEnabled" at:120 parent:notices];
    [self separatorAt:192 parent:notices];
    [self row:@"重置卡到期" detail:@"到期前提醒你。关闭此项不会关闭已授权的自动用卡。" key:@"creditAlertsEnabled" at:192 parent:notices];
    [self separatorAt:264 parent:notices];
    [self row:@"重要提醒留在屏幕上" detail:@"保留提醒窗口，直到你手动关闭；关闭此项则仅发系统通知。" key:@"persistentAlertsEnabled" at:264 parent:notices];
    [self separatorAt:336 parent:notices];
    [self row:@"通知声音" detail:@"关闭后仍会显示通知，不影响额度保护。" key:@"soundEnabled" at:336 parent:notices];

    [self section:@"自动用卡 · 单独授权" at:832 parent:body];
    NSView *credits = [self cardAt:864 height:104 parent:body];
    self.creditSwitch = [self row:@"到期前自动用一张" detail:@"不足 10 分钟且有额度可重置时，使用最早到期的一张。" key:nil at:0 parent:credits];
    self.creditSwitch.action = @selector(creditChanged:);
    [self label:@"仅限已授权账户。即时生效；睡眠或离线可能错过到期。" frame:NSMakeRect(24, 72, 592, 24) size:12 weight:NSFontWeightRegular parent:credits].textColor = NSColor.secondaryLabelColor;

    NSButton *plan = [NSButton buttonWithTitle:@"续跑计划" target:self action:@selector(openPreview:)];
    plan.frame = NSMakeRect(32, height - 56, 120, 32);
    plan.font = [NSFont systemFontOfSize:14 weight:NSFontWeightMedium];
    [root addSubview:plan];
    NSButton *system = [NSButton buttonWithTitle:@"系统通知设置" target:self action:@selector(openSystem:)];
    system.frame = NSMakeRect(0, 984, 128, 32); [body addSubview:system];
    NSButton *authorization=[NSButton buttonWithTitle:@"保护授权" target:self action:@selector(openProtection:)];
    authorization.frame=NSMakeRect(144,984,104,32); [body addSubview:authorization];
    [self label:@"偏好仅存本机，不更改系统权限。" frame:NSMakeRect(304, 992, 336, 24) size:12 weight:NSFontWeightRegular parent:body].textColor = NSColor.secondaryLabelColor;
    self.feedback = [self label:@"正在读取设置…" frame:NSMakeRect(168, height - 48, 360, 24) size:12 weight:NSFontWeightRegular parent:root];
    self.feedback.textColor = NSColor.secondaryLabelColor;
    self.saveButton = [NSButton buttonWithTitle:@"保存更改" target:self action:@selector(save:)];
    self.saveButton.frame = NSMakeRect(552, height - 56, 120, 32);
    self.saveButton.font = [NSFont systemFontOfSize:14 weight:NSFontWeightSemibold];
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
    for (NSArray *entry in @[@[self.quotaBar, five], @[self.weeklyBar, weekly]]) {
        PulseQuotaBar *bar = entry[0]; NSDictionary *window = entry[1];
        NSNumber *remaining = [window[@"remainingPercent"] isKindOfClass:NSNumber.class] ? window[@"remainingPercent"] : nil;
        bar.remaining = remaining;
        bar.accent = !fresh ? NSColor.tertiaryLabelColor : remaining.doubleValue <= 10 ? NSColor.systemRedColor
            : remaining.doubleValue <= 20 ? NSColor.systemOrangeColor : self.green;
        [bar setNeedsDisplay:YES];
    }
    self.quotaText.textColor = fresh ? NSColor.labelColor : NSColor.secondaryLabelColor;
    self.weeklyText.textColor = fresh ? NSColor.labelColor : NSColor.secondaryLabelColor;
    self.quotaText.toolTip = fresh ? @"最近一次读取的剩余额度" : @"上次读取的额度，等待更新后再判断是否恢复";
    NSDictionary *journal = [self readJSON:@"user-events.json"];
    NSArray *events = [journal[@"events"] isKindOfClass:NSArray.class] ? journal[@"events"] : @[];
    NSDictionary *latest = [events.lastObject isKindOfClass:NSDictionary.class] ? events.lastObject : @{};
    NSString *title = [latest[@"title"] isKindOfClass:NSString.class] ? latest[@"title"] : @"";
    self.recentText.stringValue = title.length ? [@"最近 · " stringByAppendingString:title] : @"暂无关键提醒";
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
- (void)openTibo:(id)sender { [self openTiboEvent:nil]; }
- (void)openTiboEvent:(NSString *)eventId {
    NSArray *saved = [self readJSON:@"user-events.json"][@"events"];
    NSMutableArray *posts = [NSMutableArray array];
    if ([saved isKindOfClass:NSArray.class]) for (id event in saved.reverseObjectEnumerator) {
        if ([event isKindOfClass:NSDictionary.class] && PulseIsTiboPost(event)) [posts addObject:event];
        if (posts.count == 10) break;
    }
    self.tiboEvents = posts;
    if (!self.tiboWindow) {
        self.tiboWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 640, 480)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
        self.tiboWindow.title = @"Tibo 动态";
        self.tiboWindow.backgroundColor = NSColor.windowBackgroundColor;
        self.tiboWindow.releasedWhenClosed = NO;
        self.tiboWindow.delegate = self;
        NSView *root = [[PulseFlippedView alloc] initWithFrame:NSMakeRect(0, 0, 640, 480)];
        root.wantsLayer = YES;
        [self.window.effectiveAppearance performAsCurrentDrawingAppearance:^{
            root.layer.backgroundColor = NSColor.windowBackgroundColor.CGColor;
        }];
        self.tiboWindow.contentView = root;
        [self label:@"Tibo 重置动态" frame:NSMakeRect(24, 24, 384, 28) size:18 weight:NSFontWeightSemibold parent:root];
        self.tiboHistoryButton = [NSButton buttonWithTitle:@"历史记录" target:self action:@selector(showTiboHistory:)];
        self.tiboHistoryButton.frame = NSMakeRect(496, 24, 120, 28);
        self.tiboHistoryButton.bordered = NO;
        self.tiboHistoryButton.font = [NSFont systemFontOfSize:14];
        self.tiboHistoryButton.contentTintColor = NSColor.secondaryLabelColor;
        [root addSubview:self.tiboHistoryButton];
        self.tiboStatus = [self label:@"暂无重置消息" frame:NSMakeRect(24, 80, 592, 32) size:24 weight:NSFontWeightSemibold parent:root];
        self.tiboStatusNote = [self label:@"" frame:NSMakeRect(24, 120, 592, 40) size:12 weight:NSFontWeightRegular parent:root];
        self.tiboStatusNote.textColor = NSColor.secondaryLabelColor;
        [self separatorAt:168 parent:root];
        self.tiboSelection = [self label:@"" frame:NSMakeRect(24, 184, 592, 24) size:14 weight:NSFontWeightMedium parent:root];
        self.tiboMetadata = [self label:@"" frame:NSMakeRect(24, 212, 592, 16) size:12 weight:NSFontWeightRegular parent:root];
        self.tiboMetadata.textColor = NSColor.secondaryLabelColor;
        self.tiboTiming = [self label:@"" frame:NSMakeRect(24, 240, 592, 40) size:12 weight:NSFontWeightRegular parent:root];
        self.tiboTiming.textColor = NSColor.secondaryLabelColor;
        NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(24, 288, 592, 104)];
        scroll.hasVerticalScroller = YES; scroll.autohidesScrollers = YES;
        scroll.drawsBackground = NO;
        self.tiboDetail = [[NSTextView alloc] initWithFrame:scroll.bounds];
        self.tiboDetail.editable = NO; self.tiboDetail.selectable = YES;
        self.tiboDetail.verticallyResizable = YES; self.tiboDetail.horizontallyResizable = NO;
        self.tiboDetail.maxSize = NSMakeSize(CGFLOAT_MAX, CGFLOAT_MAX);
        self.tiboDetail.font = [NSFont systemFontOfSize:16];
        self.tiboDetail.textContainerInset = NSMakeSize(0, 4);
        self.tiboDetail.textColor = NSColor.textColor;
        self.tiboDetail.drawsBackground = NO;
        self.tiboDetail.autoresizingMask = NSViewWidthSizable;
        self.tiboDetail.textContainer.widthTracksTextView = YES;
        scroll.documentView = self.tiboDetail;
        [root addSubview:scroll];
        self.tiboSourceButton = [NSButton buttonWithTitle:@"查看 X 原帖" target:self action:@selector(openTiboSource:)];
        self.tiboSourceButton.frame = NSMakeRect(24, 408, 160, 40);
        self.tiboSourceButton.bezelStyle = NSBezelStyleRounded;
        self.tiboSourceButton.font = [NSFont systemFontOfSize:16 weight:NSFontWeightSemibold];
        self.tiboSourceButton.bordered = NO;
        self.tiboSourceButton.wantsLayer = YES;
        self.tiboSourceButton.layer.cornerRadius = 8;
        self.tiboSourceButton.layer.backgroundColor = self.green.CGColor;
        self.tiboSourceButton.contentTintColor = NSColor.whiteColor;
        [root addSubview:self.tiboSourceButton];
        self.tiboParentButton = [NSButton buttonWithTitle:@"查看上下文" target:self action:@selector(openTiboParent:)];
        self.tiboParentButton.frame = NSMakeRect(200, 416, 128, 24);
        self.tiboParentButton.bordered = NO;
        self.tiboParentButton.font = [NSFont systemFontOfSize:14];
        self.tiboParentButton.contentTintColor = NSColor.secondaryLabelColor;
        [root addSubview:self.tiboParentButton];
        self.tiboFeedback = [self label:@"" frame:NSMakeRect(24, 456, 592, 16) size:12 weight:NSFontWeightRegular parent:root];
        self.tiboFeedback.textColor = NSColor.secondaryLabelColor;

        self.tiboHistory = [[NSPopover alloc] init];
        self.tiboHistory.behavior = NSPopoverBehaviorTransient;
        NSViewController *controller = [[NSViewController alloc] init];
        NSView *history = [[PulseFlippedView alloc] initWithFrame:NSMakeRect(0, 0, 320, 320)];
        history.wantsLayer = YES;
        [self.window.effectiveAppearance performAsCurrentDrawingAppearance:^{
            history.layer.backgroundColor = NSColor.windowBackgroundColor.CGColor;
        }];
        controller.view = history;
        [self label:@"最近 10 条 · 按收到时间排序" frame:NSMakeRect(16, 12, 288, 24) size:12 weight:NSFontWeightRegular parent:history].textColor = NSColor.secondaryLabelColor;
        NSScrollView *historyScroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(8, 48, 304, 256)];
        historyScroll.hasVerticalScroller = YES; historyScroll.autohidesScrollers = YES;
        historyScroll.drawsBackground = NO;
        self.tiboTable = [[NSTableView alloc] initWithFrame:historyScroll.bounds];
        NSTableColumn *column = [[NSTableColumn alloc] initWithIdentifier:@"announcement"];
        column.width = 288; [self.tiboTable addTableColumn:column];
        self.tiboTable.headerView = nil; self.tiboTable.rowHeight = 48;
        self.tiboTable.backgroundColor = NSColor.clearColor;
        self.tiboTable.dataSource = self; self.tiboTable.delegate = self;
        self.tiboTable.allowsEmptySelection = NO;
        self.tiboTable.accessibilityLabel = @"Tibo 动态历史列表";
        historyScroll.documentView = self.tiboTable; [history addSubview:historyScroll];
        self.tiboHistory.contentViewController = controller;
    }
    NSInteger selected = 0;
    for (NSUInteger index = 0; index < posts.count; index++) {
        NSDictionary *entry = posts[index];
        if (eventId.length && [entry[@"id"] isEqual:eventId]) selected = index;
    }
    self.tiboHistoryButton.enabled = posts.count > 0;
    self.selectedTiboIndex = selected;
    [self.tiboTable reloadData];
    if (posts.count) [self.tiboTable selectRowIndexes:[NSIndexSet indexSetWithIndex:selected] byExtendingSelection:NO];
    [self selectTibo:nil];
    if (eventId.length && ![posts filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(NSDictionary *entry, NSDictionary *bindings) {
        return [entry[@"id"] isEqual:eventId];
    }]].count) self.tiboFeedback.stringValue = @"这条提醒已不在本机保留记录中，已显示最新动态。";
    [self.tiboWindow center]; [self.tiboWindow makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}
- (NSDictionary *)selectedTibo {
    NSInteger index = self.selectedTiboIndex;
    return index >= 0 && index < self.tiboEvents.count ? self.tiboEvents[index] : @{};
}
- (NSString *)tiboKind:(NSDictionary *)event {
    NSString *type = event[@"type"];
    if ([type isEqual:@"tibo_confirmed"] || [type isEqual:@"public_reset_landed"]) return @"重置确认";
    if ([type isEqual:@"tibo_preview_expired"]) return @"预告时间已过";
    if ([type isEqual:@"tibo_limits_update"]) return @"额度动态";
    return @"重置预告";
}
- (NSString *)tiboTimestamp:(NSDictionary *)event includeYear:(BOOL)year {
    NSNumber *stamp = [event[@"sourceAt"] isKindOfClass:NSNumber.class] ? event[@"sourceAt"] : nil;
    if (!stamp) return @"原帖时间未保存";
    NSDateFormatter *format = [[NSDateFormatter alloc] init];
    format.dateFormat = year ? @"yyyy年M月d日 HH:mm" : @"M月d日 HH:mm";
    format.timeZone = [NSTimeZone timeZoneWithName:@"Asia/Shanghai"];
    return [format stringFromDate:[NSDate dateWithTimeIntervalSince1970:stamp.doubleValue]];
}
- (NSInteger)numberOfRowsInTableView:(NSTableView *)tableView { return self.tiboEvents.count; }
- (NSView *)tableView:(NSTableView *)tableView viewForTableColumn:(NSTableColumn *)column row:(NSInteger)row {
    // AppKit may finish an old layout while a refreshed history has fewer rows.
    if (row < 0 || row >= self.tiboEvents.count) return nil;
    NSDictionary *event = self.tiboEvents[row];
    NSTableCellView *cell = [[NSTableCellView alloc] initWithFrame:NSMakeRect(0, 0, 288, 48)];
    NSTextField *title = [self label:[self tiboKind:event] frame:NSMakeRect(8, 24, 272, 20) size:14 weight:NSFontWeightMedium parent:cell];
    cell.textField = title;
    [self label:[NSString stringWithFormat:@"%@ · 北京时间", [self tiboTimestamp:event includeYear:NO]] frame:NSMakeRect(8, 4, 272, 16) size:12 weight:NSFontWeightRegular parent:cell].textColor = NSColor.secondaryLabelColor;
    return cell;
}
- (void)tableViewSelectionDidChange:(NSNotification *)notification {
    if (self.tiboTable.selectedRow < 0) return;
    self.selectedTiboIndex = self.tiboTable.selectedRow;
    [self selectTibo:nil]; [self.tiboHistory close];
}
- (void)showTiboHistory:(id)sender {
    CGFloat height = MIN(320, 64 + self.tiboEvents.count * (self.tiboTable.rowHeight + self.tiboTable.intercellSpacing.height));
    NSView *view = self.tiboHistory.contentViewController.view;
    [view setFrameSize:NSMakeSize(320, height)];
    for (NSView *child in view.subviews) if ([child isKindOfClass:NSScrollView.class])
        child.frame = NSMakeRect(8, 48, 304, height - 64);
    self.tiboHistory.contentSize = view.frame.size;
    [self.tiboHistory showRelativeToRect:self.tiboHistoryButton.bounds ofView:self.tiboHistoryButton preferredEdge:NSRectEdgeMaxY];
    [self.tiboTable scrollRowToVisible:self.selectedTiboIndex];
}
- (void)selectTibo:(id)sender {
    NSDictionary *event = [self selectedTibo];
    NSURL *source = PulseXPostURL(event[@"sourceUrl"]), *parent = PulseXPostURL(event[@"parentUrl"]);
    self.tiboSourceButton.enabled = source != nil;
    self.tiboSourceButton.alphaValue = source ? 1 : 0.45;
    self.tiboSourceButton.toolTip = source ? source.absoluteString : @"这条旧记录未保存有效原帖链接";
    self.tiboParentButton.hidden = parent == nil;
    NSString *original = [event[@"sourceText"] isKindOfClass:NSString.class] ? event[@"sourceText"] : @"";
    NSDictionary *latest = nil;
    for (NSDictionary *item in self.tiboEvents) if (![item[@"type"] isEqual:@"tibo_limits_update"]) { latest = item; break; }
    NSString *type = latest[@"type"];
    if ([type isEqual:@"tibo_confirmed"] || [type isEqual:@"public_reset_landed"]) {
        self.tiboStatus.stringValue = @"公共重置已确认";
        self.tiboStatusNote.stringValue = @"这是最近收到的公共消息，个人到账以本机额度为准。";
    } else if ([type isEqual:@"tibo_preview_expired"]) {
        self.tiboStatus.stringValue = @"预告时间已过，尚未确认";
        self.tiboStatusNote.stringValue = @"未收到确认不代表重置未发生，个人额度仍独立监控。";
    } else if (latest) {
        self.tiboStatus.stringValue = @"重置预告，尚未确认";
        NSString *latestTitle = [latest[@"title"] isKindOfClass:NSString.class] ? latest[@"title"] : @"";
        NSRange split = [latestTitle rangeOfString:@"｜"];
        NSString *latestTiming = split.location == NSNotFound ? @"具体时间未定" : [latestTitle substringFromIndex:NSMaxRange(split)];
        self.tiboStatusNote.stringValue = [NSString stringWithFormat:@"%@\n预告可能调整，不代表你的账户已到账。", latestTiming];
    } else {
        self.tiboStatus.stringValue = @"暂无重置消息";
        self.tiboStatusNote.stringValue = @"收到公开预告或确认后，会在这里保留原文和入口。";
    }
    NSString *position = self.selectedTiboIndex == 0 ? @"最新" : @"此前的";
    self.tiboSelection.stringValue = event.count ? [NSString stringWithFormat:@"你正在查看：%@%@", position, [self tiboKind:event]] : @"暂无历史记录";
    self.tiboMetadata.stringValue = event.count ? [NSString stringWithFormat:@"%@（北京时间）· Tibo 的%@", [self tiboTimestamp:event includeYear:YES], parent ? @"评论" : @"公开帖子"] : @"";
    NSString *title = [event[@"title"] isKindOfClass:NSString.class] ? event[@"title"] : @"";
    NSRange divider = [title rangeOfString:@"｜"];
    NSString *timing = divider.location != NSNotFound ? [title substringFromIndex:NSMaxRange(divider)] : @"";
    self.tiboTiming.stringValue = timing.length ? [NSString stringWithFormat:@"%@%@", self.selectedTiboIndex ? @"当时预告：" : @"预告时间：", timing]
        : [event[@"sourceTextKind"] isEqual:@"summary"] ? @"来源摘录 · 未获取全文" : @"原文";
    if (latest == event && [type isEqual:@"tibo_preview"]) self.tiboTiming.stringValue = @"原文";
    if ([timing containsString:@"或"] && !(latest == event && [type isEqual:@"tibo_preview"]))
        self.tiboTiming.stringValue = [self.tiboTiming.stringValue stringByAppendingString:@"（时区表述有歧义）"];
    if (!event.count) self.tiboTiming.stringValue = @"";
    self.tiboDetail.string = original.length ? original : event.count ? @"这条记录未保存原文，可通过下方入口查看。" : @"收到的动态仅保存在本机。";
    if ([event[@"sourceTextKind"] isEqual:@"summary"] && timing.length) self.tiboDetail.string = [@"来源摘录（未获取全文）\n" stringByAppendingString:self.tiboDetail.string];
    self.tiboFeedback.stringValue = source ? @"" : event.count ? @"旧记录未保存有效原帖链接。" : @"";
    [self.tiboDetail scrollRangeToVisible:NSMakeRange(0, 0)];
}
- (void)openTiboURL:(id)value {
    NSURL *url = PulseXPostURL(value);
    if (!url) return;
    BOOL opened = self.sourceOpener ? self.sourceOpener(url) : [NSWorkspace.sharedWorkspace openURL:url];
    if (!opened) {
        self.tiboFeedback.stringValue = @"未能打开浏览器，下方链接可复制。";
        if (![self.tiboDetail.string containsString:url.absoluteString])
            self.tiboDetail.string = [self.tiboDetail.string stringByAppendingFormat:@"\n\n%@", url.absoluteString];
        [self.tiboDetail scrollRangeToVisible:NSMakeRange(self.tiboDetail.string.length - 1, 1)];
    }
}
- (void)openTiboSource:(id)sender { [self openTiboURL:[self selectedTibo][@"sourceUrl"]]; }
- (void)openTiboParent:(id)sender { [self openTiboURL:[self selectedTibo][@"parentUrl"]]; }
- (void)openProtection:(id)sender { if(self.protection) self.protection(); }
- (void)openSystem:(id)sender {
    [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple.Notifications-Settings.extension"]];
}
- (BOOL)windowShouldClose:(NSWindow *)sender {
    if (sender == self.tiboWindow) return YES;
    if (self.saving || self.creditBusy) { self.feedback.stringValue = @"正在保存，请稍候"; return NO; }
    if (!self.saved || [[self draft] isEqual:self.saved]) return YES;
    NSAlert *alert = [[NSAlert alloc] init]; alert.messageText = @"还有未保存的更改";
    alert.informativeText = @"关闭后将保留原有设置。临期自动用卡的单独授权不受影响。";
    [alert addButtonWithTitle:@"继续编辑"]; [alert addButtonWithTitle:@"放弃更改"];
    return [alert runModal] == NSAlertSecondButtonReturn;
}
- (void)windowWillClose:(NSNotification *)notification {
    for(NSWindow *window in NSApp.windows) if(window!=notification.object && window.isVisible) return;
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
- (BOOL)testTiboHistory {
    [self openTiboEvent:@"public-first"];
    NSMutableArray *opened = [NSMutableArray array];
    self.sourceOpener = ^BOOL(NSURL *url) { [opened addObject:url.absoluteString]; return YES; };
    BOOL empty = [NSProcessInfo.processInfo.environment[@"CODEX_PULSE_TEST_TIBO_EMPTY"] boolValue];
    BOOL ok = self.tiboWindow.isVisible && [self validateLayoutIn:self.tiboWindow.contentView];
    if (empty) ok = ok && !self.tiboHistoryButton.enabled && !self.tiboSourceButton.enabled
        && [self.tiboStatus.stringValue isEqual:@"暂无重置消息"];
    else {
        ok = ok && self.tiboEvents.count == 3 && [[self selectedTibo][@"id"] isEqual:@"public-first"]
            && [self.tiboDetail.string containsString:@"Lands by midnight PST."]
            && [self.tiboStatus.stringValue isEqual:@"公共重置已确认"]
            && [self.tiboSelection.stringValue containsString:@"此前的重置预告"]
            && [self.tiboMetadata.stringValue containsString:@"北京时间"] && self.tiboSourceButton.enabled && !self.tiboParentButton.hidden
            && [self.tiboTiming.stringValue containsString:@"当时预告"]
            && ![self.tiboDetail.string containsString:@"https://"];
        [self.tiboSourceButton performClick:nil]; [self.tiboParentButton performClick:nil];
        ok = ok && [opened isEqual:@[@"https://x.com/thsottiaux/status/2115273253711409208", @"https://x.com/i/status/2115273064481218829"]];
        NSString *root = NSProcessInfo.processInfo.environment[@"CODEX_PULSE_TEST_CAPTURE_DIR"];
        NSView *view = self.tiboWindow.contentView;
        [self.tiboWindow displayIfNeeded];
        [self.tiboWindow.effectiveAppearance performAsCurrentDrawingAppearance:^{
            NSBitmapImageRep *bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
            [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
            if (root.length) [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[root stringByAppendingPathComponent:@"tibo-history.png"] atomically:YES];
        }];
        // A legacy row must not reuse the previous row's actionable URL.
        [self showTiboHistory:nil];
        ok = ok && self.tiboHistory.isShown && self.tiboTable.numberOfRows == 3
            && [[self selectedTibo][@"id"] isEqual:@"public-first"] && self.tiboTable.selectedRow == 1;
        NSView *historyView = self.tiboHistory.contentViewController.view;
        [historyView.window displayIfNeeded];
        [historyView.effectiveAppearance performAsCurrentDrawingAppearance:^{
            NSBitmapImageRep *bitmap = [historyView bitmapImageRepForCachingDisplayInRect:historyView.bounds];
            [historyView cacheDisplayInRect:historyView.bounds toBitmapImageRep:bitmap];
            if (root.length) [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[root stringByAppendingPathComponent:@"tibo-timeline.png"] atomically:YES];
        }];
        [self.tiboTable selectRowIndexes:[NSIndexSet indexSetWithIndex:2] byExtendingSelection:NO];
        ok = ok && !self.tiboSourceButton.enabled && self.tiboParentButton.hidden
            && [self.tiboFeedback.stringValue containsString:@"未保存有效原帖链接"];
        [self.tiboHistory close];
        [self openTiboSource:nil]; ok = ok && opened.count == 2;
        [self openTiboEvent:@"not-retained"];
        ok = ok && [self.tiboFeedback.stringValue containsString:@"已不在本机保留记录"];
        NSMutableDictionary *longPost = [self.tiboEvents[1] mutableCopy];
        longPost[@"sourceText"] = [[@"Public source paragraph.\n" stringByPaddingToLength:12000 withString:@"Public source paragraph.\n" startingAtIndex:0] stringByAppendingString:@"END-OF-ORIGINAL"];
        self.tiboEvents = @[longPost]; self.selectedTiboIndex = 0; [self selectTibo:nil];
        ok = ok && ![self tableView:self.tiboTable viewForTableColumn:nil row:2];
        [self.tiboDetail.layoutManager ensureLayoutForTextContainer:self.tiboDetail.textContainer];
        [self.tiboDetail scrollRangeToVisible:NSMakeRange(self.tiboDetail.string.length - 1, 1)];
        ok = ok && [self.tiboDetail.string containsString:@"END-OF-ORIGINAL"]
            && self.tiboDetail.enclosingScrollView.contentView.bounds.origin.y > 0;
        self.sourceOpener = ^BOOL(NSURL *url) { return NO; };
        [self openTiboSource:nil];
        ok = ok && [self.tiboFeedback.stringValue hasPrefix:@"未能打开浏览器"]
            && [self.tiboDetail.string containsString:@"https://x.com/"];
        // Current state is independent of which historical row was clicked.
        NSDictionary *preview = @{ @"id": @"preview", @"type": @"tibo_preview", @"sourceText": @"Soon" };
        NSDictionary *expired = @{ @"id": @"expired", @"type": @"tibo_preview_expired" };
        self.tiboEvents = @[preview, longPost]; self.selectedTiboIndex = 1; [self selectTibo:nil];
        ok = ok && [self.tiboStatus.stringValue isEqual:@"重置预告，尚未确认"];
        self.tiboEvents = @[expired, preview]; [self selectTibo:nil];
        ok = ok && [self.tiboStatus.stringValue isEqual:@"预告时间已过，尚未确认"];
        self.tiboEvents = @[@{ @"type": @"tibo_limits_update" }, @{ @"type": @"tibo_confirmed" }];
        self.selectedTiboIndex = 0; [self selectTibo:nil];
        ok = ok && [self.tiboStatus.stringValue isEqual:@"公共重置已确认"];
    }
    // Exercise the exact production notification-routing function with old notification metadata.
    NSDictionary *info = @{@"pulseEventId": @"old-event", @"sourceUrl": @"https://x.com/thsottiaux/status/123"};
    ok = ok && [PulseNotificationDestination(@"pulse-view-source", @"pulse-tibo-source", info)[@"url"] isEqual:info[@"sourceUrl"]]
        && [PulseNotificationDestination(UNNotificationDefaultActionIdentifier, @"pulse-tibo-source", info)[@"eventId"] isEqual:@"old-event"]
        && [PulseNotificationDestination(UNNotificationDismissActionIdentifier, @"pulse-tibo-source", info)[@"action"] isEqual:@"none"]
        && [PulseNotificationDestination(@"pulse-view-source", @"pulse-tibo-source", @{@"sourceUrl": @"file:///tmp/unsafe"})[@"action"] isEqual:@"tibo"];
    for (NSString *url in @[@"javascript:alert(1)", @"https://x.com.evil.org/a/status/123", @"https://evil@x.com/a/status/123", @"https://x.com/a/status/not-an-id", @"https://x.com/thsottiaux"]) ok = ok && !PulseXPostURL(url);
    [self.tiboWindow orderOut:nil]; self.sourceOpener = nil;
    return ok;
}
- (BOOL)validateLayoutIn:(NSView *)parent {
    for (NSView *child in parent.subviews) {
        if (!NSContainsRect(parent.bounds, child.frame)) {
            fprintf(stderr, "Settings layout overflow: %s\n", NSStringFromClass(child.class).UTF8String);
            return NO;
        }
        if ([child isKindOfClass:NSTextField.class] && child != self.recentText) {
            NSTextField *label = (NSTextField *)child;
            CGFloat required = [label.cell cellSizeForBounds:NSMakeRect(0, 0, child.frame.size.width, 1000)].height;
            if (required > child.frame.size.height + 2) {
                fprintf(stderr, "Settings label clipped: %s\n", label.stringValue.UTF8String);
                return NO;
            }
        }
        // AppKit controls manage their own internals; only inspect our layout.
        if ([child isKindOfClass:PulseFlippedView.class] && ![self validateLayoutIn:child]) return NO;
    }
    return YES;
}
- (BOOL)validateAlignment {
    NSRect first = self.quotaText.frame, second = self.weeklyText.frame;
    NSRect firstBar = self.quotaBar.frame, secondBar = self.weeklyBar.frame;
    NSView *card = self.quotaText.superview;
    NSRect cardInWindow = [card convertRect:card.bounds toView:self.window.contentView];
    return NSEqualSizes(first.size, second.size)
        && [self.quotaText.font isEqual:self.weeklyText.font]
        && self.quotaText.alignment == self.weeklyText.alignment
        && NSMinY(first) == NSMinY(second)
        && NSEqualSizes(firstBar.size, secondBar.size)
        && NSMinY(firstBar) == NSMinY(secondBar)
        && NSMinX(firstBar) == NSMinX(first) && NSMinX(secondBar) == NSMinX(second)
        && NSMaxX(firstBar) == NSMaxX(first) && NSMaxX(secondBar) == NSMaxX(second)
        && NSMinY(self.resetText.frame) > NSMaxY(firstBar)
        && NSMaxX(cardInWindow) == NSMaxX(self.saveButton.frame)
        && NSMaxX(cardInWindow) == NSMaxX(self.health.frame);
}
- (void)runIsolatedSelfTest {
    __weak PulseSettingsWindow *weakSelf = self;
    self.afterLoad = ^{
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            PulseSettingsWindow *view = weakSelf;
            BOOL layoutOK = [view validateLayoutIn:view.window.contentView]
                && [view validateLayoutIn:view.scroll.documentView];
            BOOL alignmentOK = [view validateAlignment];
            // Prove the test rejects the original two regressions, not just
            // clipping: a smaller metric font and a differently sized bar.
            NSFont *metricFont = view.weeklyText.font;
            view.weeklyText.font = [NSFont monospacedDigitSystemFontOfSize:16 weight:NSFontWeightSemibold];
            BOOL rejectedSmallFont = ![view validateAlignment];
            view.weeklyText.font = metricFont;
            NSRect barFrame = view.weeklyBar.frame, changedBar = barFrame;
            changedBar.size.width -= 16; view.weeklyBar.frame = changedBar;
            BOOL rejectedUnequalBar = ![view validateAlignment];
            view.weeklyBar.frame = barFrame;
            alignmentOK = alignmentOK && rejectedSmallFont && rejectedUnequalBar;
            NSDictionary *state = [view readJSON:@"state.json"];
            NSDictionary *summary = state[@"lastSummary"];
            // Both missing values are valid too, and must leave tracks empty.
            BOOL quotaOK = (!summary.count && !view.quotaBar.remaining && !view.weeklyBar.remaining)
                || ([view.quotaBar.remaining isEqual:summary[@"fiveHour"][@"remainingPercent"]]
                    && [view.weeklyBar.remaining isEqual:summary[@"weekly"][@"remainingPercent"]]);
            NSTimeInterval age = [state[@"quotaCheckedAt"] isKindOfClass:NSNumber.class]
                ? NSDate.date.timeIntervalSince1970 - [state[@"quotaCheckedAt"] doubleValue] : INFINITY;
            BOOL fresh = age >= -30 && age < 180;
            NSColor *expected = !fresh ? NSColor.tertiaryLabelColor
                : view.quotaBar.remaining.doubleValue <= 10 ? NSColor.systemRedColor
                : view.quotaBar.remaining.doubleValue <= 20 ? NSColor.systemOrangeColor : view.green;
            BOOL freshnessOK = [view.quotaBar.accent isEqual:expected]
                && [view.health.stringValue isEqual:fresh ? @"● 额度刚刚更新" : @"○ 等待额度更新"];
            [view capture:@"settings.png"];
            BOOL tiboOK = [view testTiboHistory];
            view.threshold.doubleValue = 35;
            view.switches[@"soundEnabled"].state = NSControlStateValueOff;
            view.switches[@"persistentAlertsEnabled"].state = NSControlStateValueOff;
            [NSApp sendAction:view.threshold.action to:view.threshold.target from:view.threshold];
            view.afterSave = ^{
                PulseSettingsWindow *current = weakSelf;
                NSDictionary *saved = [current readJSON:@"preferences.json"];
                BOOL ok = layoutOK && alignmentOK && quotaOK && freshnessOK && tiboOK && current.window.isVisible && [saved[@"lowQuotaPercent"] integerValue] == 35
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
                    printf("{\"ok\":%s,\"regularSavePreservedConsent\":%s,\"explicitDisableWorked\":%s,\"layoutFits\":%s,\"quotaBarsMatchData\":%s,\"freshnessAndSeverityMatch\":%s,\"alignmentVerified\":%s,\"tiboHistoryVerified\":%s}\n",
                        ok && disabled ? "true" : "false", ok ? "true" : "false", disabled ? "true" : "false",
                        layoutOK ? "true" : "false", quotaOK ? "true" : "false", freshnessOK ? "true" : "false",
                        alignmentOK ? "true" : "false", tiboOK ? "true" : "false");
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
