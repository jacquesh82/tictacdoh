Pod::Spec.new do |s|
  s.name = 'TtdCapacitorNfc'
  s.version = '0.0.1'
  s.summary = 'Transport « à proximité » pour TicTacDoh, sur MultipeerConnectivity.'
  s.description = <<~DESC
    Lecture de tags NDEF via Core NFC. iOS ne peut pas presenter de ticket :
    l'emulation de carte y est reservee a Apple Pay. Le chemin viable est donc
    « un Android presente, un iPhone lit ».
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
