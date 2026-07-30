package app.tictacdoh.ble

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.os.ParcelUuid
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import java.util.UUID

/**
 * Plugin Bluetooth Low Energy.
 *
 * Topologie en étoile, imposée par le BLE et heureusement identique à celle du
 * socle : l'hôte ouvre un serveur GATT et s'annonce, les autres s'y connectent
 * en centraux. Deux caractéristiques suffisent — une pour recevoir (écriture
 * du central), une pour émettre (notification vers le central).
 *
 * ⚠️ NON COMPILÉ NI TESTÉ. Aucun SDK Android ni appareil n'était disponible.
 * Le contrat que ce fichier doit honorer est en revanche figé et vérifié par
 * les tests de `packages/transport-ble`.
 */
@CapacitorPlugin(
    name = "BleMesh",
    permissions = [
        Permission(strings = [android.Manifest.permission.BLUETOOTH_ADVERTISE], alias = "advertise"),
        Permission(strings = [android.Manifest.permission.BLUETOOTH_CONNECT], alias = "connect"),
        Permission(strings = [android.Manifest.permission.BLUETOOTH_SCAN], alias = "scan"),
    ],
)
class BleMeshPlugin : Plugin() {

    /** Nom Bluetooth du téléphone avant qu'on ne le détourne pour l'annonce. */
    private var nomOrigine: String? = null

    companion object {
        /** Caractéristique écrite par le central, lue par le périphérique. */
        private val RX_UUID: UUID = UUID.fromString("7ac0d0a1-0001-4000-8000-00805f9b34fb")

        /** Caractéristique notifiée par le périphérique vers le central. */
        private val TX_UUID: UUID = UUID.fromString("7ac0d0a1-0002-4000-8000-00805f9b34fb")

        /** Descripteur normalisé d'activation des notifications. */
        private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        /**
         * MTU demandée. 185 est la valeur qu'iOS négocie : viser au-delà
         * n'apporte rien dans une partie mixte, et 517 échoue sur beaucoup de
         * piles Android anciennes.
         */
        private const val REQUESTED_MTU = 185
    }

    private val manager by lazy {
        context.getSystemService(BluetoothManager::class.java)
    }
    private val adapter: BluetoothAdapter? get() = manager?.adapter

    private var gattServer: BluetoothGattServer? = null
    private var txCharacteristic: BluetoothGattCharacteristic? = null

    /** Centraux connectés à notre serveur, par adresse. */
    private val centrals = mutableMapOf<String, BluetoothDevice>()

    /** Connexions sortantes, quand nous sommes central. */
    private val gattClients = mutableMapOf<String, BluetoothGatt>()

    /** MTU négociée par pair. Sert à refuser une trame trop longue. */
    private val mtus = mutableMapOf<String, Int>()

    private var advertiseCallback: AdvertiseCallback? = null
    private var scanCallback: ScanCallback? = null

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val adapter = adapter
        val available = adapter != null && adapter.isEnabled
        // `isMultipleAdvertisementSupported` est faux sur une partie du parc :
        // ces appareils peuvent rejoindre mais jamais héberger. Le dire ici
        // évite un échec plus tard, incompréhensible pour l'utilisateur.
        val canAdvertise = available && adapter!!.isMultipleAdvertisementSupported
        val result = JSObject()
            .put("available", available)
            .put("canAdvertise", canAdvertise)
        if (!available) {
            result.put("reason", "Bluetooth éteint ou indisponible")
        } else if (!canAdvertise) {
            result.put("reason", "cet appareil ne sait pas s’annoncer en Bluetooth")
        }
        call.resolve(result)
    }

    @PluginMethod
    fun startAdvertising(call: PluginCall) {
        val serviceUuid = UUID.fromString(call.getString("serviceUuid") ?: return call.reject("serviceUuid manquant"))
        val fingerprintHex = call.getString("fingerprintHex") ?: return call.reject("fingerprintHex manquant")
        val localName = call.getString("localName") ?: "ttd"

        val server = manager?.openGattServer(context, serverCallback)
            ?: return call.reject("serveur GATT indisponible")
        gattServer = server

        val service = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        val rx = BluetoothGattCharacteristic(
            RX_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        val tx = BluetoothGattCharacteristic(
            TX_UUID,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ,
        )
        tx.addDescriptor(
            BluetoothGattDescriptor(
                CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
            ),
        )
        service.addCharacteristic(rx)
        service.addCharacteristic(tx)
        server.addService(service)
        txCharacteristic = tx

        val settings = AdvertiseSettings.Builder()
            // Basse latence : la découverte doit être rapide, on est en
            // présentiel et l'annonce ne dure que le temps du lobby.
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .build()

        // Les 31 octets d'une annonce héritée ne permettent pas d'y mettre le
        // code entier : on n'émet que son empreinte sur trois octets, et le
        // code complet est vérifié après connexion.
        //
        // L'empreinte est émise **deux fois**, en service data et dans le nom.
        // Ce n'est pas de la redondance gratuite : CoreBluetooth ne sait pas
        // émettre de service data, si bien qu'un hôte iPhone ne peut la placer
        // que dans son nom. Un Android qui ne lirait que le service data ne
        // verrait jamais un hôte iOS — et c'est précisément le chemin que le
        // BLE existe pour couvrir.
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(ParcelUuid(serviceUuid))
            .addServiceData(ParcelUuid(serviceUuid), fingerprintHex.hexToBytes())
            .build()
        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(true)
            .build()

        adapter?.name = "$fingerprintHex|$localName"
        val callback = object : AdvertiseCallback() {
            override fun onStartFailure(errorCode: Int) {
                call.reject("advertising refusé (code $errorCode)")
            }

            override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
                call.resolve()
            }
        }
        advertiseCallback = callback
        adapter?.bluetoothLeAdvertiser?.startAdvertising(settings, data, scanResponse, callback)
            ?: call.reject("advertising non supporté par cet appareil")
    }

    @PluginMethod
    fun stopAdvertising(call: PluginCall) {
        advertiseCallback?.let { adapter?.bluetoothLeAdvertiser?.stopAdvertising(it) }
        advertiseCallback = null
        gattServer?.close()
        gattServer = null
        restaurerNom()
        call.resolve()
    }

    /** Rend au téléphone son nom Bluetooth d'origine. */
    private fun restaurerNom() {
        val origine = nomOrigine ?: return
        nomOrigine = null
        try {
            adapter?.name = origine
        } catch (_: SecurityException) {
        }
    }

    @PluginMethod
    fun startScan(call: PluginCall) {
        val serviceUuid = UUID.fromString(call.getString("serviceUuid") ?: return call.reject("serviceUuid manquant"))
        val wanted = call.getString("fingerprintHex")

        val filters = listOf(
            ScanFilter.Builder().setServiceUuid(ParcelUuid(serviceUuid)).build(),
        )
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()

        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val advertisedName = result.scanRecord?.deviceName ?: ""
                val fromName = advertisedName.substringBefore('|', "")
                val fromServiceData = result.scanRecord
                    ?.getServiceData(ParcelUuid(serviceUuid))
                    ?.toHex()

                // On accepte les deux emplacements : un hôte Android publie
                // l'empreinte en service data, un hôte iPhone ne peut la mettre
                // que dans son nom. Ne lire qu'une source reviendrait à ignorer
                // toute une plateforme.
                val fingerprint = fromServiceData?.takeIf { it.isNotEmpty() }
                    ?: fromName.takeIf { it.length == 6 }
                    ?: return

                if (wanted != null && !wanted.equals(fingerprint, ignoreCase = true)) return

                val displayName = advertisedName.substringAfter('|', advertisedName)
                notifyListeners(
                    "discovered",
                    JSObject()
                        .put("deviceId", result.device.address)
                        .put("name", displayName.ifEmpty { result.device.address })
                        .put("rssi", result.rssi)
                        .put("fingerprintHex", fingerprint),
                )
            }
        }
        scanCallback = callback
        adapter?.bluetoothLeScanner?.startScan(filters, settings, callback)
            ?: return call.reject("scan indisponible")
        call.resolve()
    }

    @PluginMethod
    fun stopScan(call: PluginCall) {
        scanCallback?.let { adapter?.bluetoothLeScanner?.stopScan(it) }
        scanCallback = null
        call.resolve()
    }

    @PluginMethod
    fun connect(call: PluginCall) {
        val deviceId = call.getString("deviceId") ?: return call.reject("deviceId manquant")
        val device = adapter?.getRemoteDevice(deviceId) ?: return call.reject("appareil inconnu")

        val callback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    // La MTU se négocie avant toute découverte de services :
                    // l'ordre inverse laisse la connexion à 23 octets.
                    gatt.requestMtu(REQUESTED_MTU)
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    gattClients.remove(deviceId)
                    mtus.remove(deviceId)
                    notifyListeners("peerDisconnected", JSObject().put("peerId", deviceId))
                }
            }

            override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
                mtus[deviceId] = mtu
                gatt.discoverServices()
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                val tx = gatt.services
                    .firstNotNullOfOrNull { it.getCharacteristic(TX_UUID) }
                    ?: return call.reject("caractéristique de réception absente")
                gatt.setCharacteristicNotification(tx, true)
                tx.getDescriptor(CCCD_UUID)?.let { descriptor ->
                    descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    gatt.writeDescriptor(descriptor)
                }
                gattClients[deviceId] = gatt
                call.resolve(
                    JSObject()
                        .put("peerId", deviceId)
                        .put("mtu", mtus[deviceId] ?: 23),
                )
            }

            override fun onCharacteristicChanged(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                value: ByteArray,
            ) {
                notifyListeners(
                    "received",
                    JSObject()
                        .put("peerId", deviceId)
                        .put("data", Base64.encodeToString(value, Base64.NO_WRAP)),
                )
            }
        }
        device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        val peerId = call.getString("peerId") ?: return call.reject("peerId manquant")
        gattClients.remove(peerId)?.let { it.disconnect(); it.close() }
        centrals.remove(peerId)?.let { gattServer?.cancelConnection(it) }
        mtus.remove(peerId)
        call.resolve()
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val peerId = call.getString("peerId") ?: return call.reject("peerId manquant")
        val data = Base64.decode(call.getString("data") ?: "", Base64.NO_WRAP)

        val central = centrals[peerId]
        if (central != null) {
            val tx = txCharacteristic ?: return call.reject("serveur GATT non démarré")
            // Notification, et non indication : l'indication attend un accusé
            // applicatif qui doublerait la latence sans profit — la couche
            // Channel n'en a pas besoin.
            gattServer?.notifyCharacteristicChanged(central, tx, false, data)
            return call.resolve()
        }

        val gatt = gattClients[peerId] ?: return call.reject("pair non connecté")
        val rx = gatt.services.firstNotNullOfOrNull { it.getCharacteristic(RX_UUID) }
            ?: return call.reject("caractéristique d’émission absente")
        gatt.writeCharacteristic(rx, data, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE)
        call.resolve()
    }

    private val serverCallback = object : BluetoothGattServerCallback() {
        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                centrals[device.address] = device
                notifyListeners(
                    "peerConnected",
                    JSObject()
                        .put("peerId", device.address)
                        .put("mtu", mtus[device.address] ?: 23),
                )
            } else {
                centrals.remove(device.address)
                notifyListeners("peerDisconnected", JSObject().put("peerId", device.address))
            }
        }

        override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
            mtus[device.address] = mtu
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (characteristic.uuid == RX_UUID) {
                notifyListeners(
                    "received",
                    JSObject()
                        .put("peerId", device.address)
                        .put("data", Base64.encodeToString(value, Base64.NO_WRAP)),
                )
            }
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
            }
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray,
        ) {
            if (responseNeeded) {
                gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
            }
        }
    }

    override fun handleOnDestroy() {
        // Une application tuée en pleine annonce laisserait le téléphone
        // rebaptisé, et son adaptateur en train d'émettre pour personne.
        try {
            advertiseCallback?.let { adapter?.bluetoothLeAdvertiser?.stopAdvertising(it) }
        } catch (_: SecurityException) {
        }
        restaurerNom()
    }

}

private fun String.hexToBytes(): ByteArray =
    chunked(2).map { it.toInt(16).toByte() }.toByteArray()

private fun ByteArray.toHex(): String =
    joinToString("") { "%02x".format(it) }
