Pod::Spec.new do |s|
  s.name           = 'SwingAnalyzer'
  s.version        = '1.0.0'
  s.summary        = 'Native Vision-framework swing analyzer for Sacari Golf.'
  s.description    = 'Wraps VNDetectHumanBodyPoseRequest + VNDetectTrajectoriesRequest over a recorded video file. Returns per-frame body-pose joints and clubhead trajectory points to React Native via Expo modules.'
  s.author         = 'Sacari Golf'
  s.homepage       = 'https://sacari.golf'
  s.platforms      = { :ios => '14.0' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift settings — wholemodule helps with optimization, DEFINES_MODULE
  # is required so Expo's module discovery can resolve the Swift module.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
