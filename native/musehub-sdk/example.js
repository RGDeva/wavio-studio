// MuseClientSdk example for node.js.
// Copyright 2024 Muse. All rights reserved.
// 
// This is a simple example demonstrating how to connect to the Muse Hub and retrieve some information.


// Print some information for troubleshooting
console.log('process.versions:', process.versions);
console.log('process.execPath: ', process.execPath)

// Load SDK binding node
var node_path = './mac/MuseClientSdk.node';
if (process.platform == 'win32')
    node_path = './win/MuseClientSdk.node';
const MuseSdk = require(node_path);

// - Initialize the connection in test mode with a mock user without having to log in to the Hub client.
// - By setting the `mock_user` argument to false, the test mode will use the real user currently logged
// into the Hub client, if any.
// - When distributed by the Hub, products shall use MuseSdk.initializeElectron(process.execPath);
var result = MuseSdk.initializeTestMode(true);
console.log('initializeTestMode:', result.status);
const handle = result.handle;

if (result.status === 0) {
    // Connection succeeded

    // ----------------------------------------------------
    // Read UUID
    result = MuseSdk.getUserInfo(handle);
    if (result.status === 0 && result.userInfo) {
        console.log('UUID:', result.userInfo.uuid);
        console.log('E-mail:', result.userInfo.email);
        console.log('Name:', result.userInfo.name);
        console.log('Picture URL:', result.userInfo.picture_url);
    }
    else {
        console.log('Did not retrieve UUID');
    }

    // ----------------------------------------------------
    // Read SKU manually assigned to the product in Cosmos
    result = MuseSdk.getSku(handle);
    if (result.status === 0 && result.sku) {
        console.log('SKU:', result.sku.sku);
    }
    else {
        console.log('Did not retrieve SKU');
    }

    // ----------------------------------------------------
    // Read subscription option
    result = MuseSdk.getSubscriptionOption(handle);
    if (result.status === 0) {
        console.log('Subscription option:', result.subscriptionOption.assignedId);
    }
    else {
        console.log('Did not retrieve subscription option');
    }

    // ----------------------------------------------------
    // Read activation status
    result = MuseSdk.getActivationStatus(handle);
    if (result.status === 0) {
        console.log('Activation status:', result.activationStatus);
    }
    else {
        console.log('Did not retrieve activation status');
    }

    // ----------------------------------------------------
    // Read samples install location
    result = MuseSdk.getSamplesInstallLocation(handle);
    if (result.status === 0) {
        console.log('Samples install location:', result.storageLocation.path);
    }
    else {
        console.log('Did not retrieve samples install location');
    }

    // ----------------------------------------------------
    // Request product receipt
    result = MuseSdk.getReceipt(handle);
    console.log('getReceipt:', result.status, JSON.stringify(result.receipt, null, 2));
    receiptJson = result.receipt.receipt
    // Validate receipt signature
    // Public keys are declared in MuseSdkApiCrypto.h.
    // Here we copied the test public key, neglecting the `kid` key selector used
    // for rotation in production (non-TestMode).
    // In production you must use the public key corresponding to `kid`
    publicKey = "-----BEGIN PUBLIC KEY-----\n" +
        "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAodPlrmTPW+itMsZeD5u/\n" +
        "4Bu9fArgRt3KSWuuTCbKFPs3cQKkI+4QjKUyCD2Il6lw+6+rthqNz2byoEk/0BOg\n" +
        "QclB31/BGzbyMvLjE6qVF5dz8Zh/bfVHKot8C1ho9kS//iuDITqltMMd5FPfCkH5\n" +
        "zFj1vydkKkxJ1RdbC6Puf2RtUhPdABYd4WCkqse6n2NaoZVZjb+9+8sQxWvKaSKX\n" +
        "t0A3MZadBlgzAT5q/SHQLC62400cmFNKBaq95yP5FfKOH1jbt0/bnpWQUQMUxc7r\n" +
        "RGHGWto8HQfifuiXzVPbbc9J/3PPsCZ6BXAL1y7zaWBR6tpo/8DpHjq6yVwM9054\n" +
        "1wIDAQAB\n" +
        "-----END PUBLIC KEY-----\n";

    // Signature is calculated on the canonical payload, here's a quick snippet
    function toCanonicalJson(payload) {
        if (typeof payload !== 'object' || payload === null) {
            return JSON.stringify(payload);
        }

        if (Array.isArray(payload)) {
            return `[${payload.map(toCanonicalJson).join(',')}]`;
        }

        // If the payload is an object, sort its keys and canonicalize each value
        const sortedKeys = Object.keys(payload).sort();
        const canonicalEntries = sortedKeys.map(key => {
            const canonicalValue = toCanonicalJson(payload[key]);
            return `"${key}":${canonicalValue}`;
        });

        return `{${canonicalEntries.join(',')}}`;
    }
    canonicalPayload = toCanonicalJson(receiptJson.payload);

    // Verify the receipt's legitimacy
    const crypto = require('crypto');
    const verifier = crypto.createVerify('SHA256');
    verifier.update(canonicalPayload);
    valid = verifier.verify(publicKey, receiptJson.signature, 'base64');
    console.log("Cryptographic signature valid?", valid);

    // ----------------------------------------------------
    // Request Product API data
    result = MuseSdk.getProductApiData(handle, "client secret from Partner Portal", "API product id from Partner Portal");
    console.log('getProductApiData:', result.status, JSON.stringify(result.productApiData.data, null, 2));

    // ----------------------------------------------------
    // Product specific request
    result = MuseSdk.productSpecificRequest(handle, '{"version":"1.0","request_type":"myProductSpecificRequest","parameters":""}');
    console.log('productSpecificRequest:', result.status, JSON.stringify(result.response.data, null, 2));

    // ----------------------------------------------------
    // Request personal data opt-in
    result = MuseSdk.requestPersonalDataOptin(handle);
    console.log('requestPersonalDataOptin:', result.status);

    // ----------------------------------------------------
    // Test listener notifications
    cb_received = false;
    console.log('Registering listener...');
    MuseSdk.registerNotificationListener(handle, (json) => {
        console.log('LISTENER: ', JSON.stringify(json, null, 2));
        cb_received = true;
    }, "");

    console.log('Waiting for callbacks...');
    setTimeout(() => {
        console.log('Unregistering listener...');
        MuseSdk.registerNotificationListener(handle, null, "");

        // Release connection and free associated resources
        st = MuseSdk.finalize(handle);
        console.log('finalize:', st);
        // Check at least one callback was received
        // NOTE: in test mode, callbacks are only invoked when mock_user is true
        if (!cb_received) {
            throw new Error("Callback not received, are you using mock_user?");
        }
    }, 10000);
}
else {
    console.log('Did not connect to Muse Hub');
}
