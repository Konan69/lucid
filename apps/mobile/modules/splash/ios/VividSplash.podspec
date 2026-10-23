# Vivid's launch cover (VividSplash.m says what it is and why). It has no module class: it starts
# itself from +load, so Expo's autolinking only has to put it in the app. Its pictures go into the
# app's own asset catalog through the config step in app.config.ts (`withSplash`), because the
# system's launch screen and `imageNamed:` both read the main bundle.
Pod::Spec.new do |s|
  s.name           = 'VividSplash'
  s.version        = '1.0.0'
  s.summary        = "Vivid's launch cover."
  s.author         = 'Vivid'
  s.homepage       = 'https://github.com/Konan69/vivid'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.frameworks     = 'UIKit', 'QuartzCore'
  s.source_files   = 'VividSplash.m'
end
