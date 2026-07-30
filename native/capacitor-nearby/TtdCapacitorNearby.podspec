Pod::Spec.new do |s|
  s.name = 'TtdCapacitorNearby'
  s.version = '0.0.1'
  s.summary = 'Transport « à proximité » pour TicTacDoh, sur MultipeerConnectivity.'
  s.description = <<~DESC
    Pendant Apple du plugin Nearby Connections d'Android : même contrat
    TypeScript, technologies incompatibles entre elles. Relie des appareils de
    même famille ; le BLE reste le seul chemin hors-ligne entre iOS et Android.
  DESC
  s.license = 'MIT'
  s.homepage = 'https://github.com/jacquesh82/tictacdoh'
  s.author = 'TicTacDoh'
  s.source = { git: 'https://github.com/jacquesh82/tictacdoh.git', tag: s.version.to_s }

  s.ios.deployment_target = '13.0'
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
end
