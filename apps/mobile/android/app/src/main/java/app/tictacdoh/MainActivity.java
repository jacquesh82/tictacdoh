package app.tictacdoh;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import app.tictacdoh.ble.BleMeshPlugin;
import app.tictacdoh.nearby.NearbyPlugin;
import app.tictacdoh.nfc.NfcPlugin;

/**
 * Coquille native.
 *
 * Les plugins locaux doivent être déclarés avant super.onCreate() : le pont
 * Capacitor construit sa table des plugins à ce moment-là, et un enregistrement
 * plus tardif serait ignoré en silence.
 */
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(BleMeshPlugin.class);
    registerPlugin(NearbyPlugin.class);
    registerPlugin(NfcPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
