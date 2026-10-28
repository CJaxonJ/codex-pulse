#import <Cocoa/Cocoa.h>
#import <UserNotifications/UserNotifications.h>

// Public source data is not allowed to open arbitrary schemes or other hosts.
static inline NSURL *PulseXPostURL(id value) {
    if (![value isKindOfClass:NSString.class] || [value length] > 2048) return nil;
    NSURLComponents *parts = [NSURLComponents componentsWithString:value];
    if (![parts.scheme.lowercaseString isEqual:@"https"] || parts.user.length || parts.password.length || parts.port) return nil;
    if (![@[@"x.com", @"www.x.com", @"twitter.com", @"www.twitter.com"] containsObject:parts.host.lowercaseString]) return nil;
    NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"^/(?:[a-zA-Z0-9_]{1,15}|i)/(?:status|web/status)/[0-9]{1,25}/?$" options:0 error:nil];
    if (!parts.path || ![pattern firstMatchInString:parts.path options:0 range:NSMakeRange(0, parts.path.length)]) return nil;
    parts.host = @"x.com"; parts.query = nil; parts.fragment = nil;
    return parts.URL;
}

static inline BOOL PulseIsTiboPost(NSDictionary *event) {
    return [@[@"tibo_preview", @"tibo_preview_expired", @"tibo_confirmed", @"tibo_limits_update", @"public_reset_landed"] containsObject:event[@"type"]];
}

static inline NSDictionary *PulseNotificationDestination(NSString *action, NSString *category, NSDictionary *info) {
    if ([action isEqual:UNNotificationDismissActionIdentifier]) return @{@"action": @"none"};
    if (![@[@"pulse-tibo", @"pulse-tibo-source"] containsObject:category ?: @""]) return @{@"action": @"status"};
    NSURL *url = PulseXPostURL(info[@"sourceUrl"]);
    if ([action isEqual:@"pulse-view-source"] && url) return @{@"action": @"source", @"url": url.absoluteString};
    return @{@"action": @"tibo", @"eventId": [info[@"pulseEventId"] isKindOfClass:NSString.class] ? info[@"pulseEventId"] : @""};
}
