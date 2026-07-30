import Capacitor
import Foundation
import MultipeerConnectivity
import UIKit

/**
 Transport « à proximité » pour iOS, sur MultipeerConnectivity.

 Pendant Apple du plugin Nearby Connections d'Android. Les deux tiennent le
 même contrat TypeScript et **ne se parlent pas entre eux** : Multipeer est
 propre à Apple, Nearby est propre à Google. Ce transport relie donc des
 appareils de même famille, et le BLE reste le seul chemin hors-ligne entre
 iOS et Android. C'est une limite des plateformes, pas du socle.

 ## Correspondance des vocabulaires

 Le contrat parle d'`endpointId` et d'`endpointName` — les termes de Nearby.
 Multipeer, lui, ne connaît que des `MCPeerID`. On indexe donc les pairs par
 leur `displayName`, seul identifiant stable qui traverse le pont Capacitor.
 Ce nom porte le code court de la partie : c'est aussi le seul champ lisible
 pendant la découverte, donc le seul filtre possible avant connexion.

 ## État de vérification

 Compile sur runner macOS. **Jamais exécuté sur appareil** — il faudrait deux
 iPhone et une application signée. Le contrat qu'il honore est en revanche
 couvert par les tests de `packages/transport-nearby`.
 */
@objc(NearbyPlugin)
public class NearbyPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "NearbyPlugin"
    public let jsName = "Nearby"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startAdvertising", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopAdvertising", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestConnection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acceptConnection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
    ]

    private var peerId: MCPeerID?
    private var session: MCSession?
    private var advertiser: MCNearbyServiceAdvertiser?
    private var browser: MCNearbyServiceBrowser?

    /// Pairs vus, indexés par leur nom affiché — l'`endpointId` du contrat.
    private var found: [String: MCPeerID] = [:]
    /// Invitations reçues, en attente de la décision du socle.
    private var pendingInvitations: [String: (Bool, MCSession?) -> Void] = [:]

    // MARK: - Disponibilité

    @objc func isAvailable(_ call: CAPPluginCall) {
        // Multipeer existe sur tout iPhone depuis iOS 7 ; ce qui manque
        // éventuellement, c'est l'autorisation réseau local — qu'on ne peut pas
        // interroger, seulement constater à l'usage.
        call.resolve([
            "available": true,
            "reason": "",
        ])
    }

    // MARK: - Annonce (hôte)

    @objc func startAdvertising(_ call: CAPPluginCall) {
        guard let serviceId = call.getString("serviceId"),
            let endpointName = call.getString("endpointName")
        else {
            call.reject("serviceId ou endpointName manquant")
            return
        }

        let me = MCPeerID(displayName: endpointName)
        peerId = me
        let session = makeSession(for: me)

        let advertiser = MCNearbyServiceAdvertiser(
            peer: me,
            discoveryInfo: nil,
            serviceType: sanitize(serviceId)
        )
        advertiser.delegate = self
        advertiser.startAdvertisingPeer()
        self.advertiser = advertiser
        self.session = session
        call.resolve()
    }

    @objc func stopAdvertising(_ call: CAPPluginCall) {
        advertiser?.stopAdvertisingPeer()
        advertiser = nil
        call.resolve()
    }

    // MARK: - Découverte (invité)

    @objc func startDiscovery(_ call: CAPPluginCall) {
        guard let serviceId = call.getString("serviceId") else {
            call.reject("serviceId manquant")
            return
        }

        // Un pair qui ne fait que chercher a quand même besoin d'une identité
        // et d'une session : Multipeer n'a pas de mode « écoute seule ».
        let me = peerId ?? MCPeerID(displayName: UIDevice.current.name)
        peerId = me
        if session == nil { session = makeSession(for: me) }

        let browser = MCNearbyServiceBrowser(peer: me, serviceType: sanitize(serviceId))
        browser.delegate = self
        browser.startBrowsingForPeers()
        self.browser = browser
        call.resolve()
    }

    @objc func stopDiscovery(_ call: CAPPluginCall) {
        browser?.stopBrowsingForPeers()
        browser = nil
        call.resolve()
    }

    // MARK: - Connexion

    @objc func requestConnection(_ call: CAPPluginCall) {
        guard let endpointId = call.getString("endpointId"),
            let peer = found[endpointId],
            let session = session,
            let browser = browser
        else {
            call.reject("pair inconnu ou découverte non démarrée")
            return
        }
        browser.invitePeer(peer, to: session, withContext: nil, timeout: 20)
        call.resolve()
    }

    @objc func acceptConnection(_ call: CAPPluginCall) {
        guard let endpointId = call.getString("endpointId") else {
            call.reject("endpointId manquant")
            return
        }
        // L'acceptation est automatique côté socle : le code court a déjà servi
        // de filtre avant qu'on en arrive là.
        if let handler = pendingInvitations.removeValue(forKey: endpointId) {
            handler(true, session)
        }
        call.resolve()
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        // Multipeer ne sait pas couper un seul pair : `disconnect()` quitte la
        // session entière. À quatre joueurs maximum et une session par partie,
        // c'est sans conséquence — mais il faut le savoir.
        session?.disconnect()
        call.resolve()
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let endpointId = call.getString("endpointId"),
            let base64 = call.getString("data"),
            let payload = Data(base64Encoded: base64),
            let session = session
        else {
            call.reject("endpointId ou data manquant")
            return
        }
        guard let peer = session.connectedPeers.first(where: { $0.displayName == endpointId })
        else {
            call.reject("pair non connecté : \(endpointId)")
            return
        }
        do {
            // `.reliable` : le socle suppose la remise et l'ordre, comme sur les
            // autres transports. Le netcode gère la perte à son niveau, pas ici.
            try session.send(payload, toPeers: [peer], with: .reliable)
            call.resolve()
        } catch {
            call.reject("envoi impossible : \(error.localizedDescription)")
        }
    }

    // MARK: - Outils

    private func makeSession(for peer: MCPeerID) -> MCSession {
        let session = MCSession(peer: peer, securityIdentity: nil, encryptionPreference: .required)
        session.delegate = self
        return session
    }

    /**
     Normalise un identifiant de service.

     Multipeer impose un format strict — 15 caractères au plus, minuscules,
     chiffres et tirets seulement — et **plante** si on lui donne autre chose.
     Le contrat, lui, laisse l'appelant libre : on filtre donc ici plutôt que
     de faire confiance.
     */
    private func sanitize(_ serviceId: String) -> String {
        let allowed = serviceId.lowercased().map { c -> Character in
            c.isLetter || c.isNumber || c == "-" ? c : "-"
        }
        return String(allowed.prefix(15))
    }
}

// MARK: - Annonce

extension NearbyPlugin: MCNearbyServiceAdvertiserDelegate {
    public func advertiser(
        _ advertiser: MCNearbyServiceAdvertiser,
        didReceiveInvitationFromPeer peerID: MCPeerID,
        withContext context: Data?,
        invitationHandler: @escaping (Bool, MCSession?) -> Void
    ) {
        let id = peerID.displayName
        found[id] = peerID
        pendingInvitations[id] = invitationHandler
        notifyListeners(
            "connectionRequested",
            data: ["endpointId": id, "endpointName": id])
    }

    public func advertiser(
        _ advertiser: MCNearbyServiceAdvertiser,
        didNotStartAdvertisingPeer error: Error
    ) {
        notifyListeners(
            "disconnected",
            data: ["endpointId": "", "reason": error.localizedDescription])
    }
}

// MARK: - Découverte

extension NearbyPlugin: MCNearbyServiceBrowserDelegate {
    public func browser(
        _ browser: MCNearbyServiceBrowser,
        foundPeer peerID: MCPeerID,
        withDiscoveryInfo info: [String: String]?
    ) {
        let id = peerID.displayName
        found[id] = peerID
        notifyListeners("endpointFound", data: ["endpointId": id, "endpointName": id])
    }

    public func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        let id = peerID.displayName
        found.removeValue(forKey: id)
        notifyListeners("endpointLost", data: ["endpointId": id])
    }
}

// MARK: - Session

extension NearbyPlugin: MCSessionDelegate {
    public func session(
        _ session: MCSession,
        peer peerID: MCPeerID,
        didChange state: MCSessionState
    ) {
        let id = peerID.displayName
        switch state {
        case .connected:
            notifyListeners("connected", data: ["endpointId": id, "endpointName": id])
        case .notConnected:
            notifyListeners("disconnected", data: ["endpointId": id, "reason": "session fermée"])
        case .connecting:
            break
        @unknown default:
            break
        }
    }

    public func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        notifyListeners(
            "received",
            data: [
                "endpointId": peerID.displayName,
                // Base64 : le pont Capacitor ne transporte que du JSON.
                "data": data.base64EncodedString(),
            ])
    }

    // Flux et ressources ne servent pas : le socle n'échange que de petits
    // messages, et un flux imposerait une gestion de découpage que le
    // `Channel` fait déjà, mieux et de façon commune à tous les transports.
    public func session(
        _ session: MCSession,
        didReceive stream: InputStream,
        withName streamName: String,
        fromPeer peerID: MCPeerID
    ) {}

    public func session(
        _ session: MCSession,
        didStartReceivingResourceWithName resourceName: String,
        fromPeer peerID: MCPeerID,
        with progress: Progress
    ) {}

    public func session(
        _ session: MCSession,
        didFinishReceivingResourceWithName resourceName: String,
        fromPeer peerID: MCPeerID,
        at localURL: URL?,
        withError error: Error?
    ) {}
}
