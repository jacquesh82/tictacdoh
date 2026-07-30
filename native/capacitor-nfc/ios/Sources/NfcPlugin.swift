import Capacitor
import CoreNFC
import Foundation

/**
 Appairage NFC pour iOS.

 Pendant du plugin Android, mais **volontairement amputé de moitié** : iOS ne
 sait que *lire*. L'émulation de carte y est réservée à Apple Pay, et Core NFC
 n'expose rien d'équivalent au HCE d'Android. `canPresent` est donc toujours
 faux, et `startPresenting` rejette en l'expliquant plutôt que de laisser
 l'utilisateur attendre qu'on le lise.

 Le chemin viable reste donc : **un Android présente, un iPhone lit.**

 ## L'obstacle du compte gratuit

 Core NFC exige l'autorisation applicative « Near Field Communication Tag
 Reading », qui suppose un identifiant d'application déclaré chez Apple. **Un
 compte développeur gratuit n'y a pas droit.**

 Cette autorisation n'est donc **pas** déclarée dans le projet, et c'est
 délibéré : l'ajouter ferait échouer la signature d'un compte gratuit, et
 casserait l'installation de toute l'application pour une fonction secondaire.
 Le code est là, prêt ; il s'activera le jour où un compte payant sera
 disponible.

 En attendant, la session de lecture échoue à l'ouverture. L'erreur est
 remontée telle quelle plutôt que masquée : « ça ne marche pas sans qu'on
 sache pourquoi » est le pire des états.
 */
@objc(NfcPlugin)
public class NfcPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "NfcPlugin"
    public let jsName = "Nfc"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startReading", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopReading", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startPresenting", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopPresenting", returnType: CAPPluginReturnPromise),
    ]

    private var session: NFCNDEFReaderSession?

    @objc func isAvailable(_ call: CAPPluginCall) {
        let lisible = NFCNDEFReaderSession.readingAvailable
        var result: [String: Any] = [
            "available": lisible,
            // Toujours faux, et ce n'est pas une limite du socle : aucune
            // application tierce ne peut émuler une carte sur iOS.
            "canPresent": false,
        ]
        if !lisible {
            result["reason"] = "cet appareil ne sait pas lire le NFC"
        }
        call.resolve(result)
    }

    @objc func startReading(_ call: CAPPluginCall) {
        guard NFCNDEFReaderSession.readingAvailable else {
            call.reject("cet appareil ne sait pas lire le NFC")
            return
        }
        // `invalidateAfterFirstRead: false` : on veut pouvoir approcher
        // plusieurs fois sans relancer la feuille système à chaque essai, et un
        // tag mal présenté est fréquent.
        let session = NFCNDEFReaderSession(delegate: self, queue: nil, invalidateAfterFirstRead: false)
        session.alertMessage =
            call.getString("promptMessage") ?? "Approchez le téléphone de l’hôte"
        session.begin()
        self.session = session
        call.resolve()
    }

    @objc func stopReading(_ call: CAPPluginCall) {
        session?.invalidate()
        session = nil
        call.resolve()
    }

    @objc func startPresenting(_ call: CAPPluginCall) {
        call.reject(
            "iOS ne sait pas présenter de ticket : l’émulation de carte est réservée à Apple Pay. "
                + "Faites présenter par un Android, et lisez depuis cet iPhone.")
    }

    @objc func stopPresenting(_ call: CAPPluginCall) {
        // Rien à arrêter, mais on résout : le socle appelle `dispose` sans
        // savoir sur quelle plateforme il tourne, et un rejet y ferait remonter
        // une erreur sans objet.
        call.resolve()
    }
}

extension NfcPlugin: NFCNDEFReaderSessionDelegate {
    public func readerSession(
        _ session: NFCNDEFReaderSession,
        didDetectNDEFs messages: [NFCNDEFMessage]
    ) {
        for message in messages {
            // Le premier enregistrement suffit : le ticket en occupe un seul,
            // et c'est ce que `ticketToNdef` produit.
            guard let record = message.records.first else { continue }
            notifyListeners("tagRead", data: ["ndef": encode(record).base64EncodedString()])
        }
    }

    public func readerSession(_ session: NFCNDEFReaderSession, didInvalidateWithError error: Error) {
        self.session = nil
        // L'utilisateur qui ferme la feuille n'est pas une erreur à signaler.
        let code = (error as NSError).code
        if code == NFCReaderError.readerSessionInvalidationErrorUserCanceled.rawValue { return }
        notifyListeners("readerError", data: ["message": error.localizedDescription])
    }

    /**
     Réencode un enregistrement au format NDEF brut.

     Core NFC rend un objet décomposé, là où Android livre les octets tels
     quels. Le contrat parle d'octets NDEF — c'est ce que `@ttd/join` sait
     décoder — donc on reconstruit l'en-tête ici plutôt que d'imposer deux
     formats au TypeScript selon la plateforme.
     */
    private func encode(_ record: NFCNDEFPayload) -> Data {
        let type = record.type
        let payload = record.payload
        let court = payload.count <= 0xFF

        var out = Data()
        out.append(
            UInt8(
                0x80 |  // MB : premier enregistrement
                    0x40 |  // ME : dernier enregistrement
                    (court ? 0x10 : 0x00) |  // SR : longueur sur un octet
                    (record.typeNameFormat.rawValue & 0x07)))
        out.append(UInt8(type.count))
        if court {
            out.append(UInt8(payload.count))
        } else {
            let n = UInt32(payload.count)
            out.append(contentsOf: [
                UInt8((n >> 24) & 0xFF), UInt8((n >> 16) & 0xFF),
                UInt8((n >> 8) & 0xFF), UInt8(n & 0xFF),
            ])
        }
        out.append(type)
        out.append(payload)
        return out
    }
}
