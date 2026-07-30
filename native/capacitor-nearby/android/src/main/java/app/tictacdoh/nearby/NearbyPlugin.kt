package app.tictacdoh.nearby

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy

/**
 * Plugin « à proximité » pour Android, au-dessus de Nearby Connections.
 *
 * La stratégie `P2P_STAR` correspond exactement à la topologie du socle : un
 * hôte, jusqu'à trois invités, aucune liaison entre invités. Nearby monte du
 * Wi-Fi Direct quand il peut et retombe sur le Bluetooth sinon, sans que
 * l'application ait à le savoir.
 *
 * ⚠️ NON COMPILÉ NI TESTÉ. Aucun SDK Android ni appareil n'était disponible.
 * Le contrat honoré ici est figé par les tests de `packages/transport-nearby`.
 */
@CapacitorPlugin(name = "Nearby")
class NearbyPlugin : Plugin() {

    private val client by lazy { Nearby.getConnectionsClient(context) }

    /** Nom d'endpoint local, réutilisé à chaque demande de connexion. */
    private var localEndpointName: String = "ttd"

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        // Nearby Connections repose sur les services Google Play : absents des
        // appareils sans GMS, où ce transport ne fonctionnera jamais. Mieux
        // vaut le dire que d'échouer à la première connexion.
        val available = com.google.android.gms.common.GoogleApiAvailability.getInstance()
            .isGooglePlayServicesAvailable(context) == com.google.android.gms.common.ConnectionResult.SUCCESS
        call.resolve(
            JSObject()
                .put("available", available)
                .put("reason", if (available) "" else "services Google Play indisponibles"),
        )
    }

    @PluginMethod
    fun startAdvertising(call: PluginCall) {
        val serviceId = call.getString("serviceId") ?: return call.reject("serviceId manquant")
        val endpointName = call.getString("endpointName") ?: return call.reject("endpointName manquant")
        localEndpointName = endpointName

        client
            .startAdvertising(
                endpointName,
                serviceId,
                connectionLifecycle,
                AdvertisingOptions.Builder().setStrategy(Strategy.P2P_STAR).build(),
            )
            .addOnSuccessListener { call.resolve() }
            .addOnFailureListener { call.reject("advertising refusé: ${it.message}") }
    }

    @PluginMethod
    fun stopAdvertising(call: PluginCall) {
        client.stopAdvertising()
        call.resolve()
    }

    @PluginMethod
    fun startDiscovery(call: PluginCall) {
        val serviceId = call.getString("serviceId") ?: return call.reject("serviceId manquant")
        client
            .startDiscovery(
                serviceId,
                endpointDiscovery,
                DiscoveryOptions.Builder().setStrategy(Strategy.P2P_STAR).build(),
            )
            .addOnSuccessListener { call.resolve() }
            .addOnFailureListener { call.reject("découverte refusée: ${it.message}") }
    }

    @PluginMethod
    fun stopDiscovery(call: PluginCall) {
        client.stopDiscovery()
        call.resolve()
    }

    @PluginMethod
    fun requestConnection(call: PluginCall) {
        val endpointId = call.getString("endpointId") ?: return call.reject("endpointId manquant")
        val name = call.getString("endpointName") ?: localEndpointName
        client
            .requestConnection(name, endpointId, connectionLifecycle)
            .addOnSuccessListener { call.resolve() }
            .addOnFailureListener { call.reject("connexion refusée: ${it.message}") }
    }

    @PluginMethod
    fun acceptConnection(call: PluginCall) {
        val endpointId = call.getString("endpointId") ?: return call.reject("endpointId manquant")
        client
            .acceptConnection(endpointId, payloadCallback)
            .addOnSuccessListener { call.resolve() }
            .addOnFailureListener { call.reject("acceptation refusée: ${it.message}") }
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        val endpointId = call.getString("endpointId") ?: return call.reject("endpointId manquant")
        client.disconnectFromEndpoint(endpointId)
        call.resolve()
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val endpointId = call.getString("endpointId") ?: return call.reject("endpointId manquant")
        val bytes = Base64.decode(call.getString("data") ?: "", Base64.NO_WRAP)
        // `Payload.fromBytes` est plafonné à 32 ko, ce qui correspond à la MTU
        // annoncée côté TypeScript : au-delà il faudrait un flux, dont le socle
        // n'a pas besoin puisque `Channel` fragmente déjà.
        client
            .sendPayload(endpointId, Payload.fromBytes(bytes))
            .addOnSuccessListener { call.resolve() }
            .addOnFailureListener { call.reject("envoi refusé: ${it.message}") }
    }

    private val endpointDiscovery = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            notifyListeners(
                "endpointFound",
                JSObject()
                    .put("endpointId", endpointId)
                    .put("endpointName", info.endpointName),
            )
        }

        override fun onEndpointLost(endpointId: String) {
            notifyListeners("endpointLost", JSObject().put("endpointId", endpointId))
        }
    }

    private val connectionLifecycle = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            // Les deux bouts doivent accepter. Le côté TypeScript le fait
            // automatiquement : le code court a déjà servi de filtre, redemander
            // une confirmation à l'utilisateur n'apporterait rien.
            notifyListeners(
                "connectionRequested",
                JSObject()
                    .put("endpointId", endpointId)
                    .put("endpointName", info.endpointName),
            )
        }

        override fun onConnectionResult(endpointId: String, resolution: ConnectionResolution) {
            if (resolution.status.statusCode == ConnectionsStatusCodes.STATUS_OK) {
                notifyListeners(
                    "connected",
                    JSObject().put("endpointId", endpointId).put("endpointName", endpointId),
                )
            } else {
                notifyListeners(
                    "disconnected",
                    JSObject()
                        .put("endpointId", endpointId)
                        .put("reason", "connexion refusée (${resolution.status.statusCode})"),
                )
            }
        }

        override fun onDisconnected(endpointId: String) {
            notifyListeners("disconnected", JSObject().put("endpointId", endpointId))
        }
    }

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            val bytes = payload.asBytes() ?: return
            notifyListeners(
                "received",
                JSObject()
                    .put("endpointId", endpointId)
                    .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)),
            )
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            // Rien à faire : les charges utiles du socle tiennent toutes en un
            // seul morceau, la couche Channel ayant déjà fragmenté.
        }
    }
}
