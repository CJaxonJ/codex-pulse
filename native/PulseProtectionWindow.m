#import "PulseProtectionWindow.h"

@interface PulseProtectionWindow ()
@property(copy) PulseCommandRunner runner;
@property(copy) NSString *reviewId;
@property(strong) NSTextField *heading;
@property(strong) NSTextField *feedback;
@property(strong) NSButton *confirm;
@property(strong) NSButton *later;
@property(strong) NSButton *disclosure;
@property(strong) NSScrollView *details;
@property(strong) NSProgressIndicator *spinner;
@property(assign) BOOL busy;
@property(assign) BOOL ready;
@property(assign) BOOL testing;
@end

@implementation PulseProtectionWindow
- (NSTextField *)label:(NSString *)text frame:(NSRect)frame size:(CGFloat)size bold:(BOOL)bold {
    NSTextField *view=[NSTextField wrappingLabelWithString:text]; view.frame=frame;
    view.font=bold ? [NSFont boldSystemFontOfSize:size] : [NSFont systemFontOfSize:size]; view.textColor=NSColor.labelColor;
    [self.window.contentView addSubview:view]; return view;
}
- (instancetype)initWithRunner:(PulseCommandRunner)runner {
    NSWindow *window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,560,500)
        styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    self=[super initWithWindow:window]; if(!self) return nil;
    self.runner=runner; window.title=@"Codex Pulse"; window.delegate=self; window.releasedWhenClosed=NO;
    window.backgroundColor=NSColor.windowBackgroundColor;
    NSView *root=window.contentView; root.wantsLayer=YES; root.layer.backgroundColor=NSColor.windowBackgroundColor.CGColor;
    NSImageView *icon=[[NSImageView alloc] initWithFrame:NSMakeRect(246,414,68,68)];
    icon.image=[NSImage imageNamed:NSImageNameApplicationIcon]; [root addSubview:icon];
    self.heading=[self label:@"开启自动保护" frame:NSMakeRect(36,366,488,36) size:24 bold:YES];
    self.heading.alignment=NSTextAlignmentCenter;
    NSTextField *intro=[self label:@"额度不足时保存进度，恢复后接着做。" frame:NSMakeRect(36,330,488,24) size:14 bold:NO];
    intro.alignment=NSTextAlignmentCenter; intro.textColor=NSColor.secondaryLabelColor;
    NSView *benefits=[[NSView alloc] initWithFrame:NSMakeRect(32,176,496,136)];
    benefits.wantsLayer=YES; benefits.layer.cornerRadius=16;
    benefits.layer.backgroundColor=NSColor.controlBackgroundColor.CGColor; [root addSubview:benefits];
    [self label:@"低额度时暂停，留下当前进度\n\n恢复后核对任务与文件，再继续\n\n进度只存本机，不发送给开发者" frame:NSMakeRect(56,184,448,116) size:14 bold:NO];
    NSTextField *boundary=[self label:@"不会替你批准其他权限或使用重置卡。\n开启对新会话生效，不会自动打断当前任务。" frame:NSMakeRect(56,127,448,42) size:12 bold:NO];
    boundary.textColor=NSColor.secondaryLabelColor;
    self.disclosure=[NSButton buttonWithTitle:@"查看权限详情 ▸" target:self action:@selector(toggleDetails:)];
    self.disclosure.bezelStyle=NSBezelStyleInline; self.disclosure.frame=NSMakeRect(46,93,170,25);
    self.disclosure.alignment=NSTextAlignmentLeft; [root addSubview:self.disclosure];
    self.feedback=[self label:@"正在核对本机保护组件…" frame:NSMakeRect(56,62,448,24) size:12 bold:NO];
    self.feedback.textColor=NSColor.secondaryLabelColor;
    self.later=[NSButton buttonWithTitle:@"稍后开启" target:self action:@selector(closeOrRestart:)];
    self.later.frame=NSMakeRect(256,18,112,32); self.later.keyEquivalent=@"\e"; [root addSubview:self.later];
    self.confirm=[NSButton buttonWithTitle:@"开启自动保护" target:self action:@selector(enable:)];
    self.confirm.frame=NSMakeRect(378,18,134,32); self.confirm.bezelStyle=NSBezelStyleRounded;
    self.confirm.font=[NSFont systemFontOfSize:14 weight:NSFontWeightSemibold];
    self.confirm.bezelColor=[NSColor colorWithRed:0.18 green:0.52 blue:0.46 alpha:1];
    self.confirm.contentTintColor=NSColor.whiteColor; self.confirm.enabled=NO; [root addSubview:self.confirm];
    self.spinner=[[NSProgressIndicator alloc] initWithFrame:NSMakeRect(32,66,14,14)];
    self.spinner.style=NSProgressIndicatorStyleSpinning; self.spinner.controlSize=NSControlSizeSmall;
    self.spinner.displayedWhenStopped=NO; [root addSubview:self.spinner];
    self.details=[[NSScrollView alloc] initWithFrame:NSMakeRect(40,84,480,180)];
    self.details.hasVerticalScroller=YES; self.details.hidden=YES;
    NSTextView *text=[[NSTextView alloc] initWithFrame:NSMakeRect(0,0,460,180)];
    text.editable=NO; text.selectable=YES; text.font=[NSFont monospacedSystemFontOfSize:12 weight:NSFontWeightRegular];
    text.textColor=NSColor.labelColor; text.backgroundColor=NSColor.textBackgroundColor;
    self.details.documentView=text; [root addSubview:self.details];
    return self;
}
- (void)open {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular]; [self.window center]; [self showWindow:nil];
    [NSApp activateIgnoringOtherApps:YES]; [self prepare];
}
- (void)prepare {
    self.ready=NO; self.reviewId=nil; self.heading.stringValue=@"开启自动保护";
    self.confirm.title=@"开启自动保护"; self.later.title=@"稍后开启"; self.later.keyEquivalent=@"\e";
    self.busy=YES; self.confirm.enabled=NO; [self.spinner startAnimation:nil];
    self.runner(@[@"protection",@"prepare"],^(NSDictionary *result){
        self.busy=NO; [self.spinner stopAnimation:nil];
        if(![result[@"ok"] boolValue]) { self.feedback.stringValue=@"暂时无法核对，点击重试。提醒功能仍可使用。";
            self.confirm.title=@"重试"; self.confirm.enabled=YES; self.reviewId=nil;
            self.feedback.toolTip=result[@"error"]; [self testAfterPrepared:NO]; return; }
        NSMutableString *details=[NSMutableString stringWithString:@"仅授权当前 Codex Pulse 定义；变更后需要重新确认。\n\n"];
        for(NSDictionary *entry in result[@"details"]) [details appendFormat:@"%@\n%@\n%@\n%@\n\n",entry[@"purpose"],entry[@"command"],entry[@"source"],entry[@"hash"]];
        ((NSTextView *)self.details.documentView).string=details;
        self.reviewId=result[@"reviewId"]; self.ready=[result[@"trusted"] boolValue]; self.confirm.enabled=YES;
        if(self.ready) [self showConfirmed];
        else { self.confirm.title=@"开启自动保护"; self.feedback.stringValue=@"仅在你确认后授权，可随时在 Codex 中撤销。"; }
        [self testAfterPrepared:YES];
    });
}
- (void)showConfirmed {
    self.ready=YES; self.heading.stringValue=@"保护授权已确认";
    self.feedback.stringValue=@"新会话生效 · 现在重启会停止正在运行的任务";
    self.feedback.textColor=[NSColor colorWithRed:0.18 green:0.52 blue:0.46 alpha:1];
    self.confirm.title=@"完成"; self.later.title=@"重启 Codex"; self.later.keyEquivalent=@"";
}
- (void)enable:(id)sender {
    if(self.busy) return;
    if(self.ready) { [self.window close]; return; }
    if(!self.reviewId) { [self prepare]; return; }
    self.busy=YES; self.confirm.enabled=NO; self.later.enabled=NO;
    self.feedback.stringValue=@"正在确认授权…"; [self.spinner startAnimation:nil];
    self.runner(@[@"protection",@"enable",@"--review",self.reviewId,@"--yes"],^(NSDictionary *result){
        self.busy=NO; self.confirm.enabled=YES; self.later.enabled=YES; [self.spinner stopAnimation:nil];
        if([result[@"ok"] boolValue] && [result[@"trusted"] boolValue]) [self showConfirmed];
        else { self.reviewId=nil; self.confirm.title=@"重新核对"; self.feedback.stringValue=@"尚未确认生效，请重新核对。提醒功能仍可使用。";
            self.feedback.textColor=NSColor.systemOrangeColor; self.feedback.toolTip=result[@"error"]; }
        if(self.testing) [self finishTest: self.ready];
    });
}
- (void)toggleDetails:(id)sender {
    BOOL expanded=self.details.hidden;
    NSRect frame=self.window.frame; CGFloat delta=expanded ? 200 : -200; frame.origin.y-=delta; frame.size.height+=delta;
    for(NSView *view in self.window.contentView.subviews) {
        if(view!=self.details && view!=self.confirm && view!=self.later && view!=self.feedback && view!=self.spinner) {
            NSRect f=view.frame; f.origin.y+=delta; view.frame=f;
        }
    }
    [self.window setFrame:frame display:YES animate:NO]; self.details.hidden=!expanded;
    self.disclosure.title=expanded ? @"收起权限详情 ▾" : @"查看权限详情 ▸";
}
- (void)closeOrRestart:(id)sender {
    if(self.testing && !self.ready) { [self finishTest:YES]; return; }
    if(!self.ready) { [self.window close]; return; }
    // Only this explicit button requests a restart. Confirming trust itself
    // never interrupts a user's task.
    if(self.testing) return;
    NSTask *task=[[NSTask alloc] init]; task.executableURL=[NSURL fileURLWithPath:@"/usr/bin/osascript"];
    task.arguments=@[@"-e",@"tell application \"ChatGPT\" to quit\ndelay 2\ntell application \"ChatGPT\" to activate"];
    if([task launchAndReturnError:nil]) [self.window close];
    else self.feedback.stringValue=@"请在方便时重新打开 Codex，授权已经保留。";
}
- (BOOL)windowShouldClose:(NSWindow *)sender { return !self.busy; }
- (void)windowWillClose:(NSNotification *)notification {
    for(NSWindow *window in NSApp.windows) if(window!=self.window && window.isVisible) return;
    [NSApp terminate:nil];
}
- (void)runIsolatedSelfTest { self.testing=YES; }
- (void)capture:(NSString *)name {
    NSString *directory=NSProcessInfo.processInfo.environment[@"CODEX_PULSE_TEST_CAPTURE_DIR"];
    NSView *view=self.window.contentView; [view displayIfNeeded]; NSBitmapImageRep *bitmap=[view bitmapImageRepForCachingDisplayInRect:view.bounds];
    [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
    [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:[directory stringByAppendingPathComponent:name] atomically:YES];
}
- (void)testAfterPrepared:(BOOL)ok {
    if(!self.testing) return;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC/2),dispatch_get_main_queue(),^{
        [self capture:@"protection.png"];
        NSString *mode=NSProcessInfo.processInfo.environment[@"CODEX_PULSE_TEST_CONSENT_ACTION"];
        if(!ok) { [self finishTest:NO]; return; }
        if([mode isEqual:@"cancel"]) { [self.later performClick:nil]; return; }
        if(!self.ready) { [self.disclosure performClick:nil]; [self capture:@"protection-details.png"]; [self.disclosure performClick:nil]; }
        if(self.ready) [self finishTest:YES]; else [self.confirm performClick:nil];
    });
}
- (void)finishTest:(BOOL)ok {
    [self capture:@"protection-result.png"];
    printf("{\"ok\":%s,\"trusted\":%s}\n",ok?"true":"false",self.ready?"true":"false"); fflush(stdout); [NSApp terminate:nil];
}
@end
