// Vivid's launch cover: Vivid's face on screen from the moment the app has a scene until React
// Native has drawn its first content, alive while it waits, then opening onto the app.
//
// The system's launch screen is taken down as soon as the app has a window, and the app's own
// first screen is drawn only once its JavaScript has started. In between the window showed its
// plain background: a white (or black) screen on every launch. This fills that gap. Its first
// frame is the launch screen's own picture (Info.plist UILaunchScreen, image "VividSplash") in
// the same place, so the two read as one.
//
// The face is the app's own (packages/design/marks/src/face.ts `faceGeometry`,
// apps/mobile/src/ui/Face.tsx): eyes 11% wide and 24% tall, 22% apart, 38% down, turned 6 degrees
// out; "thinking" leans the head back 8 degrees on the curve (0.2, 0, 0, 1) in 280 ms.
//
// The motion, and why each part is there:
// - Still for 250 ms: the handoff from the launch screen must not be seen.
// - Then the face leans into "thinking" and blinks once at 0.9 s, again every 2.6 s. That is how
//   Vivid shows it is working everywhere else in the app; here it says the app is loading without
//   a spinner. It only runs while the app has not drawn, and never longer than six seconds.
// - When the app has drawn, the cover opens in a circle from the face outward (420 ms, the strong
//   ease-out 0.23, 1, 0.32, 1) while the face steps back and fades (160 ms). The app is already
//   drawn underneath, so nothing waits for the motion to end, and touches pass through throughout.
// - A phone ready before the lean starts just opens. The cover never adds waiting time.
// - With Reduce Motion on there is no lean, no blink and no circle: a 200 ms fade.
//
// It is a window of its own above the app's, not a view inside the app's window: the updates
// library replaces the app window's root view controller once it has chosen which JavaScript to
// run (ExpoUpdatesReactDelegateHandler.swift), which removes whatever the window held, and Expo
// makes the app's window when the scene connects (ExpoAppSceneDelegate.swift). A separate window
// depends on neither. It needs nothing from the app's code: it starts itself when the library is
// loaded (+load) and listens for RCTContentDidAppearNotification, which React Native posts on the
// main queue when a root view first has content (RCTRootComponentView.mm).
#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>

static const CGFloat kFace = 120;
static const CGFloat kEyeWidth = 13;   // round(120 * 0.11)
static const CGFloat kEyeHeight = 29;  // round(120 * 0.24)
static const CGFloat kEyeGap = 26;     // round(120 * 0.22)
static const CGFloat kEyeTop = 45.6;   // 120 * 0.38

@interface VividSplash : NSObject
@end

static CALayer *face;

// Holds the cover's view and keeps the face in its middle whatever size the window settles at
// (a layer does not follow its view's size by itself).
@interface VividSplashHolder : UIViewController
@end

@implementation VividSplashHolder
- (void)viewDidLayoutSubviews {
  [super viewDidLayoutSubviews];
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  face.position = CGPointMake(CGRectGetMidX(self.view.bounds), CGRectGetMidY(self.view.bounds));
  [CATransaction commit];
}
@end

@implementation VividSplash

static UIWindow *cover;
static CAShapeLayer *eyes[2];
// Content has appeared: from then on there is nothing to cover, whether or not it ever showed.
static BOOL appeared;

// The colour the app last painted its window with, which expo-system-ui keeps in the defaults
// (ExpoSystemUIModule.swift, key "ExpoSystemUI.backgroundColor", 0xAARRGGBB). It is the theme the
// Person chose, which may not be the system's light or dark. None kept: the system background.
+ (UIColor *)ground {
  NSInteger kept = [NSUserDefaults.standardUserDefaults integerForKey:@"ExpoSystemUI.backgroundColor"];
  if (kept <= 0) return UIColor.systemBackgroundColor;
  return [UIColor colorWithRed:((kept >> 16) & 0xFF) / 255.0
                         green:((kept >> 8) & 0xFF) / 255.0
                          blue:(kept & 0xFF) / 255.0
                         alpha:1.0];
}

+ (CAMediaTimingFunction *)easeOut {
  return [CAMediaTimingFunction functionWithControlPoints:0.23:1.0:0.32:1.0];
}

+ (void)after:(NSTimeInterval)seconds run:(dispatch_block_t)block {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), block);
}

+ (void)load {
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  NSOperationQueue *main = NSOperationQueue.mainQueue;
  // Whichever comes first with a scene to draw in: the scene connecting, or launch finishing.
  [center addObserverForName:UISceneWillConnectNotification
                      object:nil
                       queue:main
                  usingBlock:^(NSNotification *note) {
                    if ([note.object isKindOfClass:UIWindowScene.class]) [self showIn:note.object];
                  }];
  [center addObserverForName:UIApplicationDidFinishLaunchingNotification
                      object:nil
                       queue:main
                  usingBlock:^(NSNotification *note) {
                    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
                      if ([scene isKindOfClass:UIWindowScene.class]) {
                        [self showIn:(UIWindowScene *)scene];
                        return;
                      }
                    }
                    // An app without a scene manifest, as this build is, may have no scene object
                    // yet: its window is then made for the screen, as the app's own is.
                    [self showIn:nil];
                  }];
  [center addObserverForName:@"RCTContentDidAppearNotification"
                      object:nil
                       queue:main
                  usingBlock:^(NSNotification *note) {
                    [self leave];
                  }];
}

// The face in layers, so its head can lean and its eyes can blink: the disc is the launch
// picture without its eyes (the same pixels), and each eye is a capsule of its own.
+ (CALayer *)faceIn:(CGRect)bounds {
  CALayer *head = [CALayer layer];
  head.bounds = CGRectMake(0, 0, kFace, kFace);
  head.position = CGPointMake(CGRectGetMidX(bounds), CGRectGetMidY(bounds));
  UIImage *disc = [UIImage imageNamed:@"VividSplashDisc"];
  if (disc != nil) {
    head.contents = (__bridge id)disc.CGImage;
    head.contentsScale = disc.scale;
  }
  CGFloat left = (kFace - kEyeWidth * 2 - kEyeGap) / 2;
  for (int index = 0; index < 2; index++) {
    CAShapeLayer *eye = [CAShapeLayer layer];
    eye.bounds = CGRectMake(0, 0, kEyeWidth, kEyeHeight);
    eye.path = [UIBezierPath bezierPathWithRoundedRect:eye.bounds cornerRadius:kEyeWidth / 2].CGPath;
    eye.fillColor = [UIColor colorWithRed:15 / 255.0 green:15 / 255.0 blue:15 / 255.0 alpha:1].CGColor;
    eye.position = CGPointMake(left + (kEyeWidth + kEyeGap) * index + kEyeWidth / 2, kEyeTop + kEyeHeight / 2);
    eye.transform = CATransform3DMakeRotation((index == 0 ? -6 : 6) * M_PI / 180, 0, 0, 1);
    [head addSublayer:eye];
    eyes[index] = eye;
  }
  return head;
}

+ (void)showIn:(nullable UIWindowScene *)scene {
  if (appeared || cover != nil) return;
  UIViewController *holder = [VividSplashHolder new];
  holder.view.backgroundColor = [self ground];
  face = [self faceIn:holder.view.bounds];
  [holder.view.layer addSublayer:face];
  UIWindow *window = scene != nil ? [[UIWindow alloc] initWithWindowScene:scene]
                                  : [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  window.rootViewController = holder;
  window.windowLevel = UIWindowLevelNormal + 1;
  window.userInteractionEnabled = NO;
  // Shown, and never made key: the app's own window stays the one that takes the keyboard.
  window.hidden = NO;
  cover = window;
  if (!UIAccessibilityIsReduceMotionEnabled()) {
    [self after:0.25 run:^{ [self think]; }];
    [self after:0.9 run:^{ [self blink]; }];
  }
  [self after:6 run:^{ [self leave]; }];
}

// Leans the head back into Vivid's "thinking" pose. Once, and it stays there.
+ (void)think {
  if (cover == nil) return;
  CGFloat lean = -8 * M_PI / 180;
  CABasicAnimation *tilt = [CABasicAnimation animationWithKeyPath:@"transform.rotation.z"];
  tilt.fromValue = @0;
  tilt.toValue = @(lean);
  tilt.duration = 0.28;
  tilt.timingFunction = [CAMediaTimingFunction functionWithControlPoints:0.2:0.0:0.0:1.0];
  face.transform = CATransform3DMakeRotation(lean, 0, 0, 1);
  [face addAnimation:tilt forKey:@"tilt"];
}

// Closes and opens the eyes, then asks for the next blink for as long as the cover is up.
+ (void)blink {
  if (cover == nil) return;
  for (int index = 0; index < 2; index++) {
    CAKeyframeAnimation *lid = [CAKeyframeAnimation animationWithKeyPath:@"transform.scale.y"];
    lid.values = @[ @1, @0.12, @1 ];
    lid.keyTimes = @[ @0, @0.42, @1 ];
    lid.duration = 0.26;
    lid.timingFunctions = @[
      [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseIn], [self easeOut]
    ];
    [eyes[index] addAnimation:lid forKey:@"blink"];
  }
  [self after:2.6 run:^{ [self blink]; }];
}

+ (void)leave {
  appeared = YES;
  UIWindow *window = cover;
  if (window == nil) return;
  cover = nil;
  UIView *view = window.rootViewController.view;
  void (^gone)(void) = ^{
    window.hidden = YES;
    window.rootViewController = nil;
    face = nil;
    eyes[0] = nil;
    eyes[1] = nil;
  };
  if (UIAccessibilityIsReduceMotionEnabled() || view == nil) {
    [UIView animateWithDuration:0.2
        animations:^{ window.alpha = 0; }
        completion:^(BOOL finished) { gone(); }];
    return;
  }
  // The cover with a round hole in it, growing from the face until it has left the screen.
  CGRect bounds = view.bounds;
  CGPoint centre = face.position;
  CGFloat reach = hypot(CGRectGetWidth(bounds), CGRectGetHeight(bounds)) / 2 + 24;
  UIBezierPath * (^holed)(CGFloat) = ^UIBezierPath *(CGFloat radius) {
    UIBezierPath *path = [UIBezierPath bezierPathWithRect:CGRectInset(bounds, -reach, -reach)];
    [path appendPath:[UIBezierPath bezierPathWithArcCenter:centre radius:radius startAngle:0 endAngle:2 * M_PI clockwise:YES]];
    return path;
  };
  CAShapeLayer *mask = [CAShapeLayer layer];
  mask.fillRule = kCAFillRuleEvenOdd;
  mask.path = holed(reach).CGPath;
  view.layer.mask = mask;

  [CATransaction begin];
  [CATransaction setCompletionBlock:gone];
  CABasicAnimation *open = [CABasicAnimation animationWithKeyPath:@"path"];
  open.fromValue = (__bridge id)holed(1).CGPath;
  open.toValue = (__bridge id)holed(reach).CGPath;
  open.duration = 0.42;
  open.timingFunction = [self easeOut];
  [mask addAnimation:open forKey:@"open"];

  // The face steps back and is gone before the circle has passed its own edge.
  CABasicAnimation *fade = [CABasicAnimation animationWithKeyPath:@"opacity"];
  fade.fromValue = @1;
  fade.toValue = @0;
  CABasicAnimation *back = [CABasicAnimation animationWithKeyPath:@"transform.scale"];
  back.fromValue = @1;
  back.toValue = @0.82;
  CAAnimationGroup *away = [CAAnimationGroup animation];
  away.animations = @[ fade, back ];
  away.duration = 0.16;
  away.timingFunction = [self easeOut];
  away.fillMode = kCAFillModeForwards;
  away.removedOnCompletion = NO;
  [face addAnimation:away forKey:@"away"];
  [CATransaction commit];
}

@end
