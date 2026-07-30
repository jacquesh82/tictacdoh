require 'json'

Pod::Spec.new do |s|
  s.name = 'TtdBleMesh'
  s.version = '0.0.1'
  s.summary = 'Transport Bluetooth Low Energy pour TicTacDoh.'
  s.description = <<~DESC
    Plugin Capacitor exposant un maillage BLE : l'hôte s'annonce en
    périphérique GATT, les autres s'y connectent en centraux. C'est le seul
    chemin hors-ligne commun à iOS et Android — MultipeerConnectivity est
    propre à Apple, et le Wi-Fi Direct d'Android est injoignable depuis iOS.
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
