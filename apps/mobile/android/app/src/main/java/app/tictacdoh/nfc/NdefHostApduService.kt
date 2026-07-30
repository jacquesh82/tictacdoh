package app.tictacdoh.nfc

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/**
 * Émulation d'un tag NFC Forum de type 4.
 *
 * Fait passer le téléphone pour une carte NDEF en lecture seule. N'importe
 * quel lecteur — un autre Android, un iPhone, un lecteur de badges — y voit un
 * tag ordinaire et n'a rien à savoir de nous. C'est ce qui rend l'appairage
 * possible avec un iPhone, qui sait lire mais jamais présenter.
 *
 * ## Le dialogue, dans l'ordre
 *
 * Le lecteur mène. Quatre commandes se succèdent toujours dans le même ordre,
 * et la spécification interdit d'en sauter :
 *
 * 1. `SELECT` de l'application NDEF, par son identifiant `D2760000850101`.
 * 2. `SELECT` du fichier de capacités (CC), puis `READ BINARY` : le lecteur y
 *    apprend la taille maximale et l'identifiant du fichier NDEF.
 * 3. `SELECT` du fichier NDEF.
 * 4. `READ BINARY` : d'abord les deux octets de longueur, puis le contenu.
 *
 * Le lecteur lit souvent par tranches, et rarement dans l'ordre naïf : il faut
 * donc répondre à n'importe quel couple (décalage, longueur), et pas seulement
 * à une lecture séquentielle.
 *
 * ## État de vérification
 *
 * Compile. **Jamais exercé sur matériel** — il faut deux appareils et un
 * contact physique, qu'aucun test ne simule. Le format NDEF présenté est en
 * revanche produit par `ticketToNdef`, couvert par les tests de `@ttd/join`.
 */
class NdefHostApduService : HostApduService() {

    companion object {
        /** Identifiant de l'application NDEF, normalisé par le NFC Forum. */
        private val NDEF_AID = byteArrayOf(
            0xD2.toByte(), 0x76, 0x00, 0x00, 0x85.toByte(), 0x01, 0x01
        )

        private const val FILE_CC = 0xE103
        private const val FILE_NDEF = 0xE104

        private val OK = byteArrayOf(0x90.toByte(), 0x00)
        private val ERR_NOT_FOUND = byteArrayOf(0x6A, 0x82.toByte())
        private val ERR_UNSUPPORTED = byteArrayOf(0x6D, 0x00)
        private val ERR_END_OF_FILE = byteArrayOf(0x6B, 0x00)

        /**
         * Fichier de capacités.
         *
         * Contenu figé, tel que la spécification l'exige : version 2.0,
         * 256 octets par lecture, fichier NDEF `E104` de 32 Ko maximum, en
         * lecture libre (`0x00`) et écriture interdite (`0xFF`).
         */
        private val CC_FILE = byteArrayOf(
            0x00, 0x0F,             // longueur du CC
            0x20,                   // version 2.0
            0x00, 0xFF.toByte(),    // taille max en lecture
            0x00, 0xFF.toByte(),    // taille max en écriture
            0x04, 0x06,             // contrôle de fichier NDEF, longueur 6
            0xE1.toByte(), 0x04,    // identifiant du fichier NDEF
            0x7F, 0xFF.toByte(),    // taille max du fichier NDEF
            0x00,                   // lecture libre
            0xFF.toByte(),          // écriture interdite
        )

        /** Contenu présenté, préfixé de sa longueur sur deux octets. */
        @Volatile
        private var ndefFile: ByteArray? = null

        @Volatile
        private var onRead: (() -> Unit)? = null

        /** Arme la présentation. Le service peut ne pas être encore instancié. */
        @JvmStatic
        fun present(record: ByteArray, onRead: () -> Unit) {
            // La longueur en tête fait partie du fichier NDEF : un lecteur la
            // lit avant le contenu pour savoir combien d'octets demander.
            val file = ByteArray(record.size + 2)
            file[0] = ((record.size shr 8) and 0xFF).toByte()
            file[1] = (record.size and 0xFF).toByte()
            record.copyInto(file, 2)
            ndefFile = file
            this.onRead = onRead
        }

        @JvmStatic
        fun stop() {
            ndefFile = null
            onRead = null
        }
    }

    /** Fichier actuellement sélectionné par le lecteur. */
    private var selected = 0

    override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray {
        val apdu = commandApdu ?: return ERR_UNSUPPORTED
        if (apdu.size < 4) return ERR_UNSUPPORTED

        val ins = apdu[1].toInt() and 0xFF
        val p1 = apdu[2].toInt() and 0xFF
        val p2 = apdu[3].toInt() and 0xFF

        return when {
            // SELECT par nom : l'application NDEF.
            ins == 0xA4 && p1 == 0x04 -> {
                if (containsAid(apdu)) OK else ERR_NOT_FOUND
            }
            // SELECT par identifiant de fichier.
            ins == 0xA4 && p1 == 0x00 -> selectFile(apdu)
            ins == 0xB0 -> readBinary(p1, p2, apdu)
            else -> ERR_UNSUPPORTED
        }
    }

    private fun containsAid(apdu: ByteArray): Boolean {
        // L'AID est dans les données ; sa position dépend de la longueur du
        // champ Lc. Le chercher est plus robuste que de calculer un décalage.
        outer@ for (start in 0..apdu.size - NDEF_AID.size) {
            for (i in NDEF_AID.indices) {
                if (apdu[start + i] != NDEF_AID[i]) continue@outer
            }
            return true
        }
        return false
    }

    private fun selectFile(apdu: ByteArray): ByteArray {
        if (apdu.size < 7) return ERR_UNSUPPORTED
        val id = ((apdu[5].toInt() and 0xFF) shl 8) or (apdu[6].toInt() and 0xFF)
        return when (id) {
            FILE_CC, FILE_NDEF -> {
                selected = id
                OK
            }
            else -> ERR_NOT_FOUND
        }
    }

    private fun readBinary(p1: Int, p2: Int, apdu: ByteArray): ByteArray {
        val source = when (selected) {
            FILE_CC -> CC_FILE
            FILE_NDEF -> ndefFile ?: return ERR_NOT_FOUND
            else -> return ERR_NOT_FOUND
        }

        val offset = (p1 shl 8) or p2
        if (offset > source.size) return ERR_END_OF_FILE

        // Le = 0 signifie 256 octets, pas zéro. Sans ce cas particulier, un
        // lecteur qui demande une pleine tranche reçoit une réponse vide.
        val demande = if (apdu.size > 4) (apdu[apdu.size - 1].toInt() and 0xFF) else 0
        val longueur = minOf(if (demande == 0) 256 else demande, source.size - offset)

        val out = ByteArray(longueur + 2)
        source.copyInto(out, 0, offset, offset + longueur)
        OK.copyInto(out, longueur)

        // Signaler la lecture une seule fois, quand le contenu part vraiment —
        // et non aux lectures du fichier de capacités, qui ne prouvent rien.
        if (selected == FILE_NDEF && offset > 0) onRead?.invoke()
        return out
    }

    override fun onDeactivated(reason: Int) {
        // Le lecteur s'est éloigné : la prochaine session repartira de zéro.
        selected = 0
    }
}
