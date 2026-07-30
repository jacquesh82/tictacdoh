package app.tictacdoh.nfc

import android.app.Activity
import android.content.ComponentName
import android.nfc.NfcAdapter
import android.nfc.cardemulation.CardEmulation
import android.nfc.Tag
import android.nfc.tech.Ndef
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Appairage NFC.
 *
 * Deux moitiés bien distinctes, parce que le matériel ne les traite pas
 * pareil :
 *
 * - **Lire** utilise le mode lecteur (`enableReaderMode`), qui court-circuite
 *   la répartition d'intentions du système. C'est ce qui évite qu'Android
 *   ouvre une autre application — ou relance la nôtre — quand un tag approche.
 * - **Présenter** passe par [NdefHostApduService], qui émule une carte NFC
 *   Forum de type 4. Cette classe ne fait que lui confier les octets.
 *
 * L'asymétrie iOS / Android est assumée dans le contrat : un iPhone ne peut
 * que lire, l'émulation de carte y étant réservée à Apple Pay.
 */
@CapacitorPlugin(name = "Nfc")
class NfcPlugin : Plugin() {

    private val adapter: NfcAdapter?
        get() = NfcAdapter.getDefaultAdapter(context)

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val adapter = adapter
        val available = adapter != null && adapter.isEnabled
        val result = JSObject()
            .put("available", available)
            // Android sait émuler dès lors que la puce est active : l'inverse
            // d'iOS, où ce sera toujours faux.
            .put("canPresent", available)
        if (adapter == null) {
            result.put("reason", "aucune puce NFC sur cet appareil")
        } else if (!adapter.isEnabled) {
            result.put("reason", "NFC désactivé dans les réglages")
        }
        call.resolve(result)
    }

    // MARK: - Lecture

    @PluginMethod
    fun startReading(call: PluginCall) {
        val adapter = adapter
        if (adapter == null || !adapter.isEnabled) {
            call.reject("NFC indisponible ou désactivé")
            return
        }
        val activity: Activity = activity

        // `NFC_A | NFC_B | NFC_F | NFC_V` couvre les technologies courantes.
        // `SKIP_NDEF_CHECK` est délibérément absent : on veut que le système
        // fasse la lecture NDEF pour nous.
        val flags = NfcAdapter.FLAG_READER_NFC_A or
            NfcAdapter.FLAG_READER_NFC_B or
            NfcAdapter.FLAG_READER_NFC_F or
            NfcAdapter.FLAG_READER_NFC_V or
            // Sans cela, le système joue un son et affiche une animation à
            // chaque tag — perturbant quand on approche deux téléphones.
            NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS

        activity.runOnUiThread {
            adapter.enableReaderMode(activity, { tag -> onTag(tag) }, flags, null)
            call.resolve()
        }
    }

    private fun onTag(tag: Tag) {
        val ndef = Ndef.get(tag) ?: return
        try {
            ndef.connect()
            // `cachedNdefMessage` évite un aller-retour quand le système a déjà
            // lu le message pendant la découverte.
            val message = ndef.cachedNdefMessage ?: ndef.ndefMessage ?: return
            val records = message.records
            if (records.isEmpty()) return
            // Le premier enregistrement suffit : le ticket en occupe un seul,
            // et c'est ce que `ticketToNdef` produit.
            val bytes = records[0].toByteArray()
            val payload = JSObject().put("ndef", Base64.encodeToString(bytes, Base64.NO_WRAP))
            notifyListeners("tagRead", payload)
        } catch (error: Exception) {
            // Un tag retiré trop vite lève ici. Ce n'est pas une erreur digne
            // d'être remontée : l'utilisateur va simplement recommencer.
        } finally {
            try {
                ndef.close()
            } catch (_: Exception) {
            }
        }
    }

    @PluginMethod
    fun stopReading(call: PluginCall) {
        val activity: Activity = activity
        activity.runOnUiThread {
            adapter?.disableReaderMode(activity)
            call.resolve()
        }
    }

    // MARK: - Présentation

    @PluginMethod
    fun startPresenting(call: PluginCall) {
        val base64 = call.getString("ndef")
        if (base64 == null) {
            call.reject("ndef manquant")
            return
        }
        val adapter = adapter
        if (adapter == null || !adapter.isEnabled) {
            call.reject("NFC indisponible ou désactivé")
            return
        }
        NdefHostApduService.present(Base64.decode(base64, Base64.NO_WRAP)) {
            notifyListeners("ticketRead", JSObject().put("at", System.currentTimeMillis()))
        }

        // Réclamer la priorité au premier plan.
        //
        // L'AID de l'application NDEF n'est pas exclusif : le service intégré
        // « Embedded tag » le revendique aussi, et le système affiche alors une
        // notification de conflit en laissant l'utilisateur trancher dans les
        // réglages — constaté sur Galaxy S24. Cette API donne la priorité à
        // notre service tant que l'application est visible, ce qui est
        // exactement la portée voulue : on ne veut pas intercepter le NFC en
        // arrière-plan.
        preferService(true)
        call.resolve()
    }

    @PluginMethod
    fun stopPresenting(call: PluginCall) {
        preferService(false)
        NdefHostApduService.stop()
        call.resolve()
    }

    /** Prend ou rend la priorité sur l'AID NDEF, au premier plan seulement. */
    private fun preferService(prefer: Boolean) {
        val adapter = adapter ?: return
        val activity: Activity = activity
        val emulation = CardEmulation.getInstance(adapter)
        val component = ComponentName(activity, NdefHostApduService::class.java)
        activity.runOnUiThread {
            try {
                if (prefer) emulation.setPreferredService(activity, component)
                else emulation.unsetPreferredService(activity)
            } catch (error: Exception) {
                // Certaines surcouches refusent l'appel hors premier plan. Ce
                // n'est pas bloquant : le service reste déclaré, l'utilisateur
                // devra simplement le choisir dans les réglages.
            }
        }
    }

    override fun handleOnDestroy() {
        // Laisser le mode lecteur actif après la fermeture capterait des tags
        // pour une application qui n'écoute plus.
        try {
            adapter?.disableReaderMode(activity)
        } catch (_: Exception) {
        }
        preferService(false)
        NdefHostApduService.stop()
    }
}
