#import "PulseSettingsWindow.h"

@interface PulseProtectionWindow : NSWindowController <NSWindowDelegate>
- (instancetype)initWithRunner:(PulseCommandRunner)runner;
- (void)open;
- (void)runIsolatedSelfTest;
@end
