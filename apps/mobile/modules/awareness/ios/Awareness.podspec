Pod::Spec.new do |s|
  s.name = 'Awareness'
  s.version = '1.0.0'
  s.summary = 'Vivid ActivityKit registration and protected native action authority'
  s.description = s.summary
  s.license = 'MIT'
  s.author = 'Vivid'
  s.homepage = 'https://github.com/Konan69/vivid'
  s.platform = :ios, '15.1'
  s.source = { :git => 'https://github.com/Konan69/vivid.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.swift_version = '5.9'
end
