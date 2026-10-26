#import <Cocoa/Cocoa.h>

typedef void (^PulseCommandRunner)(NSArray<NSString *> *, void (^)(NSDictionary *));

@interface PulseSettingsWindow : NSWindowController <NSWindowDelegate>
- (instancetype)initWithDataDirectory:(NSString *)directory
                       commandRunner:(PulseCommandRunner)runner
                       previewAction:(dispatch_block_t)preview
                    protectionAction:(dispatch_block_t)protection;
- (void)open;
- (void)runIsolatedSelfTest;
@end
