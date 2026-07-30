import Capacitor
import CoreBluetooth
import Foundation

/**
 Plugin Bluetooth Low Energy pour iOS.

 Même topologie que sur Android : l'hôte devient périphérique et publie un
 service GATT, les autres s'y connectent en centraux. CoreBluetooth impose de
 tenir les deux rôles dans des objets distincts — `CBPeripheralManager` pour
 héberger, `CBCentralManager` pour rejoindre — d'où les deux moitiés de ce
 fichier.

 État de vérification, à jour : **compile** sur un runner macOS de GitHub
 (`.github/workflows/ios.yml`) — vérifié en cassant volontairement ce fichier
 pour s'assurer qu'il est bien dans la cible, et non ignoré silencieusement.
 En revanche il n'a **jamais tourné sur un appareil** : il faudrait deux
 téléphones et une application signée. Le contrat qu'il doit honorer est figé
 et vérifié par les tests de `packages/transport-ble`, mais aucun test ne peut
 prouver que CoreBluetooth se comporte comme attendu.

 Réserve importante pour la phase de mise au point sur appareil : en arrière-
 plan, iOS cesse de diffuser l'UUID de service dans l'annonce principale et le
 déplace dans une zone « overflow » que seuls d'autres appareils Apple savent
 lire. Un Android ne verra donc plus un hôte iPhone dès que l'application
 passe en arrière-plan. C'est une limite de la plateforme, pas du socle.
 */
@objc(BleMeshPlugin)
public class BleMeshPlugin: CAPPlugin, CAPBridgedPlugin, CBPeripheralManagerDelegate,
    CBCentralManagerDelegate, CBPeripheralDelegate
{
    // MARK: - Enregistrement auprès du pont

    /**
     Déclaration des méthodes exposées au JavaScript.

     Depuis Capacitor 6, un plugin qui ne conforme pas à `CAPBridgedPlugin`
     n'est tout simplement jamais enregistré : les appels côté web échouent
     alors sur « plugin not implemented », sans la moindre erreur de
     compilation pour l'annoncer. Cette table est donc la contrepartie exacte
     de l'interface `BleMeshPlugin` de `packages/transport-ble` — toute méthode
     oubliée ici est une méthode absente à l'exécution.
     */
    public let identifier = "BleMeshPlugin"
    public let jsName = "BleMesh"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startAdvertising", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopAdvertising", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
    ]

    /// Caractéristique écrite par le central, lue par le périphérique.
    private let rxUuid = CBUUID(string: "7AC0D0A1-0001-4000-8000-00805F9B34FB")
    /// Caractéristique notifiée par le périphérique vers le central.
    private let txUuid = CBUUID(string: "7AC0D0A1-0002-4000-8000-00805F9B34FB")

    private var peripheralManager: CBPeripheralManager?
    private var centralManager: CBCentralManager?

    private var txCharacteristic: CBMutableCharacteristic?
    /// Centraux abonnés à nos notifications, par identifiant.
    private var subscribedCentrals: [String: CBCentral] = [:]
    /// Périphériques auxquels nous sommes connectés, par identifiant.
    private var connectedPeripherals: [String: CBPeripheral] = [:]
    private var rxCharacteristics: [String: CBCharacteristic] = [:]
    private var discovered: [String: CBPeripheral] = [:]

    private var serviceUuid: CBUUID?
    private var wantedFingerprint: String?
    private var pendingConnect: [String: CAPPluginCall] = [:]

    /// Appels `isAvailable` en attente que CoreBluetooth annonce son état.
    private var pendingAvailability: [CAPPluginCall] = []

    // MARK: - Disponibilité

    /**
     Disponibilité réelle du Bluetooth.

     **L'état de CoreBluetooth est asynchrone.** Juste après la création d'un
     `CBCentralManager`, `state` vaut `.unknown` : le système ne le renseigne
     qu'au premier appel de `centralManagerDidUpdateState`. Répondre tout de
     suite revenait donc à répondre « indisponible » à tous les coups —
     constaté sur iPhone SE, où l'application n'a jamais atteint la radio et où
     le journal ne montrait pas même de demande d'autorisation.

     L'appel est donc mis en attente jusqu'à ce que l'état soit connu. Un
     garde-temps le libère si rien ne vient, plutôt que de laisser l'interface
     figée sur « recherche en cours » indéfiniment.
     */
    @objc func isAvailable(_ call: CAPPluginCall) {
        if peripheralManager == nil {
            peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
        }
        if centralManager == nil {
            centralManager = CBCentralManager(delegate: self, queue: nil)
        }

        // L'état est déjà connu : les appels suivants passent par ici.
        if let state = centralManager?.state, state != .unknown, state != .resetting {
            resolveAvailability(call)
            return
        }

        pendingAvailability.append(call)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            // Sans ce garde-temps, un Bluetooth qui ne répond pas laisserait la
            // promesse JavaScript pendante pour toujours.
            self?.flushAvailability()
        }
    }

    private func flushAvailability() {
        let calls = pendingAvailability
        pendingAvailability = []
        for call in calls { resolveAvailability(call) }
    }

    private func resolveAvailability(_ call: CAPPluginCall) {
        let state = centralManager?.state ?? .unknown
        let poweredOn = state == .poweredOn
        call.resolve([
            "available": poweredOn,
            // Contrairement au navigateur, iOS sait s'annoncer.
            "canAdvertise": poweredOn,
            "reason": poweredOn ? "" : raison(for: state),
        ])
    }

    /// Message utile plutôt qu'un « indisponible » qui n'apprend rien.
    private func raison(for state: CBManagerState) -> String {
        switch state {
        case .poweredOff: return "Bluetooth éteint"
        case .unauthorized: return "autorisation Bluetooth refusée pour cette application"
        case .unsupported: return "cet appareil ne gère pas le Bluetooth basse énergie"
        case .resetting: return "la pile Bluetooth redémarre"
        case .unknown: return "état du Bluetooth inconnu — réessayez"
        @unknown default: return "état du Bluetooth inattendu"
        }
    }

    /**
     Nom annoncé, taillé pour le budget d'annonce.

     Même contrainte que sur Android : le nom voyage dans la réponse au scan,
     plafonnée à 31 octets. iOS ne refuse pas quand ça déborde — il **tronque
     en silence**, ce qui est pire : l'empreinte survit puisqu'elle est en tête,
     mais le nom arrive amputé sans que rien ne le signale.

     On coupe donc nous-mêmes, en octets et sur une frontière de caractère.
     */
    private func nomAnnonce(_ fingerprint: String, _ localName: String) -> String {
        let budget = 29 - fingerprint.utf8.count - 1
        var nom = localName
        while nom.utf8.count > budget && !nom.isEmpty {
            nom.removeLast()
        }
        return "\(fingerprint)|\(nom)"
    }

    // MARK: - Périphérique (hôte)

    @objc func startAdvertising(_ call: CAPPluginCall) {
        guard let uuidString = call.getString("serviceUuid"),
            let localName = call.getString("localName")
        else {
            call.reject("serviceUuid ou localName manquant")
            return
        }
        let service = CBUUID(string: uuidString)
        serviceUuid = service

        let rx = CBMutableCharacteristic(
            type: rxUuid,
            properties: [.write, .writeWithoutResponse],
            value: nil,
            permissions: [.writeable]
        )
        let tx = CBMutableCharacteristic(
            type: txUuid,
            properties: [.notify],
            value: nil,
            permissions: [.readable]
        )
        txCharacteristic = tx

        let gattService = CBMutableService(type: service, primary: true)
        gattService.characteristics = [rx, tx]
        peripheralManager?.add(gattService)

        // CoreBluetooth n'expose pas de champ « service data » à l'émission :
        // l'empreinte du code voyage donc dans le nom local. C'est la seule
        // différence de format avec Android, et le côté TypeScript la masque.
        let fingerprint = call.getString("fingerprintHex") ?? ""
        peripheralManager?.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [service],
            CBAdvertisementDataLocalNameKey: nomAnnonce(fingerprint, localName),
        ])
        call.resolve()
    }

    @objc func stopAdvertising(_ call: CAPPluginCall) {
        peripheralManager?.stopAdvertising()
        peripheralManager?.removeAllServices()
        call.resolve()
    }

    public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        // Le rôle périphérique a son propre cycle d'état ; on s'en sert pour
        // débloquer aussi les appels en attente, au cas où le central tarderait.
        flushAvailability()
    }

    public func peripheralManager(
        _ peripheral: CBPeripheralManager,
        central: CBCentral,
        didSubscribeTo characteristic: CBCharacteristic
    ) {
        let id = central.identifier.uuidString
        subscribedCentrals[id] = central
        notifyListeners(
            "peerConnected",
            data: [
                "peerId": id,
                // `maximumUpdateValueLength` est déjà la charge utile nette :
                // on rajoute l'en-tête ATT pour que le TypeScript retranche
                // toujours la même chose, quelle que soit la plateforme.
                "mtu": central.maximumUpdateValueLength + 3,
            ])
    }

    public func peripheralManager(
        _ peripheral: CBPeripheralManager,
        central: CBCentral,
        didUnsubscribeFrom characteristic: CBCharacteristic
    ) {
        let id = central.identifier.uuidString
        subscribedCentrals.removeValue(forKey: id)
        notifyListeners("peerDisconnected", data: ["peerId": id])
    }

    public func peripheralManager(
        _ peripheral: CBPeripheralManager,
        didReceiveWrite requests: [CBATTRequest]
    ) {
        for request in requests {
            guard request.characteristic.uuid == rxUuid, let value = request.value else { continue }
            notifyListeners(
                "received",
                data: [
                    "peerId": request.central.identifier.uuidString,
                    "data": value.base64EncodedString(),
                ])
        }
        if let first = requests.first {
            peripheral.respond(to: first, withResult: .success)
        }
    }

    // MARK: - Central (invité)

    @objc func startScan(_ call: CAPPluginCall) {
        guard let uuidString = call.getString("serviceUuid") else {
            call.reject("serviceUuid manquant")
            return
        }
        wantedFingerprint = call.getString("fingerprintHex")
        centralManager?.scanForPeripherals(
            withServices: [CBUUID(string: uuidString)],
            // Les annonces répétées sont nécessaires : le RSSI et le nom
            // n'arrivent pas toujours à la première.
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
        )
        call.resolve()
    }

    @objc func stopScan(_ call: CAPPluginCall) {
        centralManager?.stopScan()
        call.resolve()
    }

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        // C'est ici, et seulement ici, que l'état devient exploitable.
        flushAvailability()
    }

    public func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        let localName = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? ""
        let parts = localName.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
        let fingerprint = parts.count > 1 ? String(parts[0]) : ""
        let name = parts.count > 1 ? String(parts[1]) : localName

        if let wanted = wantedFingerprint, !wanted.isEmpty,
            fingerprint.lowercased() != wanted.lowercased()
        {
            return
        }

        let id = peripheral.identifier.uuidString
        discovered[id] = peripheral
        notifyListeners(
            "discovered",
            data: [
                "deviceId": id,
                "name": name,
                "rssi": RSSI.intValue,
                "fingerprintHex": fingerprint,
            ])
    }

    @objc func connect(_ call: CAPPluginCall) {
        guard let deviceId = call.getString("deviceId"), let peripheral = discovered[deviceId]
        else {
            call.reject("appareil inconnu ou hors de portée")
            return
        }
        call.keepAlive = true
        pendingConnect[deviceId] = call
        peripheral.delegate = self
        centralManager?.connect(peripheral, options: nil)
    }

    public func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices(serviceUuid.map { [$0] })
    }

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        for service in peripheral.services ?? [] {
            peripheral.discoverCharacteristics([rxUuid, txUuid], for: service)
        }
    }

    public func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        let id = peripheral.identifier.uuidString
        for characteristic in service.characteristics ?? [] {
            if characteristic.uuid == txUuid {
                peripheral.setNotifyValue(true, for: characteristic)
            }
            if characteristic.uuid == rxUuid {
                rxCharacteristics[id] = characteristic
            }
        }
        connectedPeripherals[id] = peripheral

        if let call = pendingConnect.removeValue(forKey: id) {
            call.resolve([
                "peerId": id,
                "mtu": peripheral.maximumWriteValueLength(for: .withoutResponse) + 3,
            ])
        }
    }

    public func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard characteristic.uuid == txUuid, let value = characteristic.value else { return }
        notifyListeners(
            "received",
            data: [
                "peerId": peripheral.identifier.uuidString,
                "data": value.base64EncodedString(),
            ])
    }

    public func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        let id = peripheral.identifier.uuidString
        connectedPeripherals.removeValue(forKey: id)
        rxCharacteristics.removeValue(forKey: id)
        notifyListeners("peerDisconnected", data: ["peerId": id])
    }

    // MARK: - Envoi

    @objc func send(_ call: CAPPluginCall) {
        guard let peerId = call.getString("peerId"),
            let base64 = call.getString("data"),
            let data = Data(base64Encoded: base64)
        else {
            call.reject("peerId ou data manquant")
            return
        }

        if let central = subscribedCentrals[peerId], let tx = txCharacteristic {
            peripheralManager?.updateValue(data, for: tx, onSubscribedCentrals: [central])
            call.resolve()
            return
        }

        guard let peripheral = connectedPeripherals[peerId],
            let rx = rxCharacteristics[peerId]
        else {
            call.reject("pair non connecté")
            return
        }
        // Sans accusé : attendre une réponse ATT par trame doublerait la
        // latence pour une garantie que la couche Channel n'utilise pas.
        peripheral.writeValue(data, for: rx, type: .withoutResponse)
        call.resolve()
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        guard let peerId = call.getString("peerId") else {
            call.reject("peerId manquant")
            return
        }
        if let peripheral = connectedPeripherals[peerId] {
            centralManager?.cancelPeripheralConnection(peripheral)
        }
        subscribedCentrals.removeValue(forKey: peerId)
        call.resolve()
    }
}
