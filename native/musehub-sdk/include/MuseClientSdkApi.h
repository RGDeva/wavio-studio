/*
 * MuseClientSdk
 * Copyright 2025 Muse. All rights reserved.
 *
 * Use, distribution and modification of this code and associated binaries is subject to license.
 */

#pragma once

#if defined(__APPLE__)
#if defined(MUSECLIENTSDK_DYNAMIC)
#define MuseSdkApi __attribute__((visibility("default")))
#else
#define MuseSdkApi
#endif
#define MuseSdkStaticApi __attribute__((visibility("default")))
#elif defined(_MSC_VER)
#if defined(MUSECLIENTSDK_DYNAMIC)
#define MuseSdkApi __declspec(dllexport)
#else
#define MuseSdkApi
#endif
#define MuseSdkStaticApi
#endif


#ifdef __cplusplus
#include <cstdint>
extern "C" {
#else
#include <stdbool.h>
#include <stdint.h>
#endif

/*
  Muse SDK

  - The API is single threaded.
  - All functions are synchronous and can block the caller up to a few seconds while waiting for external resources.
    If responsiveness is a concern, it is suggested to use this API on a dedicated thread instead of the UI thread.
  - All returned char* fields are either valid null-terminated strings, or nullptr if not available
  - All returned memory structures must be released using the dedicated `MuseSdk_releaseXXX` functions
*/

/* Status code returned by some API functions */
typedef enum
{
    MuseSdk_Status_SUCCESS = 0,
    MuseSdk_Status_INVALID_ARGS,
    MuseSdk_Status_CONNECTION_ERROR,
    MuseSdk_Status_INVALID_DATA_RECEIVED,
    MuseSdk_Status_ALREADY_INITIALIZED,
    MuseSdk_Status_DLL_NOT_LOADED,
} MuseSdk_Status;

/* Opaque type for the MuseSdk */
typedef void* MuseSdk_Handle;

/**************************************************************************
  Initialization and finalization
*/

/*
  Initializes the SDK<=>MuseHub channel for subsequent SDK API calls.
  NOTE: This is specific for native apps.
  `handle` receives a MuseSdk_Handle, or nullptr if failed.
  Returns a status code to troubleshoot errors.
*/
MuseSdkApi MuseSdk_Status MuseSdk_initialize(MuseSdk_Handle* handle);

/*
  Initializes the SDK<=>MuseHub channel for subsequent SDK API calls.
  NOTE: This is specific for Electron apps.
  `handle` receives a MuseSdk_Handle, or nullptr if failed.
  Returns a status code to troubleshoot errors.
*/
MuseSdkApi MuseSdk_Status MuseSdk_initializeElectron(MuseSdk_Handle* handle, const char* process_execPath);

/*
  *TEST MODE* to be used in alternative to `MuseSdk_initialize` to ease integration testing.
  Initializes the SDK<=>MuseHub channel for subsequent SDK API calls.
  Set `mock_user` to true to quickly test without having to setup a user in Cosmos.
  Set `mock_user` to false to test when a real user is logged in the Hub.
  `handle` receives a MuseSdk_Handle, or nullptr if failed.
  Returns a status code to troubleshoot errors.
*/
MuseSdkApi MuseSdk_Status MuseSdk_initializeTestMode(bool mock_user, MuseSdk_Handle* handle);

/*
  Releases the SDK<=>MuseHub channel and any associated resources.
  `handle` must be a valid handle previously returned by a MuseSdk_initialize call.
*/
MuseSdkApi MuseSdk_Status MuseSdk_finalize(MuseSdk_Handle* handle);

/**************************************************************************
   User information
*/

typedef struct
{
    char* uuid;  /* Anonymised Unique User ID */

    /* These fields contain data only if the user opted in for personal data sharing */
    char* email;
    char* name;
    char* picture_url;
} MuseSdk_UserInfo;

/*
  Retrieves the user ID associated with the active MuseHub account.
  `handle` must be a valid handle previously returned by a MuseSdk_initialize call.
  `info` must point to a MuseSdk_UserInfo pointer that receives the user information associated with the active
  MuseHub account. The returned pointer must be released with `MuseSdk_releaseUserInfo` after use.
*/
MuseSdkApi MuseSdk_Status MuseSdk_getUserInfo(MuseSdk_Handle handle, MuseSdk_UserInfo** info);

/* Releases a MuseSdk_UserInfo struct previously created by `MuseSdk_getUserInfo`. */
MuseSdkApi void MuseSdk_releaseUserInfo(MuseSdk_UserInfo** info);

/*
  Call this if personal data is absolutely needed to create a user account and the UUID is not sufficient.
  If the user has not opted-in already, the Hub will show a popup requesting to opt-in as requested by the product.
  Use judiciously and try to use only the UUID when possible.
  If the user has already opted-in, getUserInfo already returns the personal data fields and this won't do anything.
  An asynchronous notification is received whenever the user changes the opt-in setting, see MuseSdk_registerCallback.
*/
MuseSdkApi MuseSdk_Status MuseSdk_requestPersonalDataOptin(MuseSdk_Handle handle);

/**************************************************************************
  Product information
*/

typedef struct
{
    char* sku;
} MuseSdk_Sku;

/*
  Retrieves the SKU specified in Muse Cosmos for the current product.
  `handle` must be a valid handle previously returned by a MuseSdk_initialize call.
  `sku` must point to a MuseSdk_Sku pointer that receives the SKU entered in Cosmos, if any.
  The returned pointer must be released with `MuseSdk_releaseSku` after use.
*/
MuseSdkApi MuseSdk_Status MuseSdk_getSku(MuseSdk_Handle handle, MuseSdk_Sku** info);

/* Releases a MuseSdk_Sku struct previously created by `MuseSdk_getSku`. */
MuseSdkApi void MuseSdk_releaseSku(MuseSdk_Sku** info);

typedef struct
{
    char* assigned_id;
} MuseSdk_SubscriptionOption;

/*
  Retrieves the ID specified in Muse Cosmos for the currently authorized product subscription/option.
  `handle` must be a valid handle previously returned by a MuseSdk_initialize call.
  `id` must point to a MuseSdk_SubscriptionOption pointer that receives the user information.
  The returned pointer must be released with `MuseSdk_releaseSubscriptionOption` after use.
*/
MuseSdkApi MuseSdk_Status MuseSdk_getSubscriptionOption(MuseSdk_Handle handle, MuseSdk_SubscriptionOption** info);

/* Releases a MuseSdk_SubscriptionOption struct previously created by `MuseSdk_getSubscriptionOption`. */
MuseSdkApi void MuseSdk_releaseSubscriptionOption(MuseSdk_SubscriptionOption** info);

typedef enum
{
    MuseSdk_ActivationStatus_INACTIVE = 0,
    MuseSdk_ActivationStatus_ACTIVE,
} MuseSdk_ActivationStatus;

/*
  Retrieves the current activation status for the running product.
  For DRM-protected products, this will always return ACTIVE.
  `handle` must be a valid handle previously returned by a MuseSdk_initialize call.
  `status` must point to a MuseSdk_ActivationStatus pointer that receives the user information.
*/
#ifdef __cplusplus
[[deprecated("MuseSdk_getActivationStatus will be removed in a future version. Use the cryptographically"
    " secure MuseSdk_getReceipt API instead to verify product and IAP authorizations.")]]
#endif
    MuseSdkApi MuseSdk_Status MuseSdk_getActivationStatus(MuseSdk_Handle handle, MuseSdk_ActivationStatus* status);


/**************************************************************************
  Content
*/

typedef struct
{
    char* path;
} MuseSdk_StorageLocation;

/*
  Retrieves the current samples install location.
  `handle` must be a valid handle previously returned by a MuseSdk_initialize call.
  `status` must point to a MuseSdk_StorageLocation pointer that receives the user information.
*/
MuseSdkApi MuseSdk_Status MuseSdk_getSamplesInstallLocation(MuseSdk_Handle handle, MuseSdk_StorageLocation** location);

/* Releases a MuseSdk_StorageLocation struct previously created by `getSamplesInstallLocation`. */
MuseSdkApi void MuseSdk_releaseSamplesInstallLocation(MuseSdk_StorageLocation** location);


/**************************************************************************
  Authorization receipt, In-App Purchase
*/

typedef struct
{
    /*
      The JSON IAP receipt. Format:
      {
        "version": string,          // Protocol version - for future use
        "kid": string,              // Key ID of secret to use for signature verification, e.g. "MuseSdk_PublicKeys_0"
        "payload": {                // Container for receipt data
          "items": [                // Array of purchased items
            {
              "item_id": string,    // Unique identifier for purchased item (IAP or the actual product checking its authorization)
              "purchase_date": int, // Timestamp in Unix epoch at which this item was purchased
              "uuid": string,       // UUID for which this item is valid
              "valid_until": int,   // Expiration timestamp in Unix epoch, optional, mostly for subscriptions
            }
          ],
          "system_id": string,      // Identifies the computer for which this receipt is valid
          "timestamp": int          // Timestamp in Unix epoch at which this payload was generated
        },
        "signature": string         // Base64-encoded server-side RS256 signature of the canonicalized `payload` using private key `kid`
      }

      NOTE: Verify the signature and system_id field in the client to validate the payload content.
      See MuseSdk_verifySignature and MuseSdk_getSystemId.
    */
    char* receipt;
} MuseSdk_Receipt;

/*
  Retrieve a receipt of purchased items, including the client product and any IAP.
  `handle` must be a valid handle previously returned by a MuseSdk_initialize call.
  `receipt` must point to a MuseSdk_Receipt pointer that receives the user information.
  The returned receipt may be an empty string if the product has no valid/unexpired
   license for the current user and system.
*/
MuseSdkApi MuseSdk_Status MuseSdk_getReceipt(MuseSdk_Handle handle, MuseSdk_Receipt** receipt);

/* Releases a MuseSdk_Receipt struct previously created by `MuseSdk_getReceipt`. */
MuseSdkApi void MuseSdk_releaseReceipt(MuseSdk_Receipt** receipt);

/**************************************************************************
  Product API
*/

typedef struct
{
    /*
      The data to enable Product API functionality through Muse Hub
      {
        "apiGatewayUrl": "https://cosmos-product-api...",
        "token": "<JWT token>"
      }
    */
    char* data;
} MuseSdk_ProductApiData;

/*
  Retrieve Product API data, such as gateway and access token.
  `handle` must be a valid handle previously returned by a MuseSdk_initialize call.
  `client_secret` the custom secret set up in the Partner Portal.
  `api_product_id` the Product ID displayed in the Partner Portal for the API product.
  `data` must point to a MuseSdk_ProductApiData pointer that receives data.
  The returned data may be an empty string if the product is not activated for API use
  on the MuseHub Partner Portal.
*/
MuseSdkApi MuseSdk_Status MuseSdk_getProductApiData(MuseSdk_Handle handle, const char* client_secret, const char* api_product_id, MuseSdk_ProductApiData** data);

/* Releases a `MuseSdk_ProductApiData` struct previously created by `MuseSdk_getProductApiData`. */
MuseSdkApi void MuseSdk_releaseProductApiData(MuseSdk_ProductApiData** data);

/**************************************************************************
  Product-specific API
  Flexible private API for product-specific functionality.
*/

typedef struct
{
    /*
      The returned data is specific to certain products and not documented publicly.
    */
    char* data;
} MuseSdk_ProductSpecificResponse;

/*
  Product-specific request. Arguments and returned data depend on a product-specific private API, not documented publicly.
  `handle` must be a valid handle previously returned by a MuseSdk_initialize call.
  `request` product-specific request.
  `response` must point to a MuseSdk_ProductSpecificResponse pointer that receives data.
*/
MuseSdkApi MuseSdk_Status MuseSdk_productSpecificRequest(MuseSdk_Handle handle, const char* request, MuseSdk_ProductSpecificResponse** response);

/* Releases a `MuseSdk_ProductSpecificResponse` struct previously created by `MuseSdk_getProductApiData`. */
MuseSdkApi void MuseSdk_releaseProductSpecificResponse(MuseSdk_ProductSpecificResponse** response);

/**************************************************************************
  Security functionality
  These functions are statically linked into the target through the dedicated static SDK library.
*/

/*
  Retrieves a unique hardware system identifier that can be used to check system_id in receipts.
  `id` Pointer to a pointer receiving the system ID string (null-terminated).
*/
typedef struct
{
    char* id;
} MuseSdk_SystemId;

MuseSdkStaticApi MuseSdk_Status MuseSdk_getSystemId(MuseSdk_SystemId** id);
MuseSdkStaticApi void MuseSdk_releaseSystemId(MuseSdk_SystemId** id);

/*
  Verifies a payload signature using the specified public key id.
  `payload` Null-terminated payload string to verify.
  `signature` Null-terminated signature string to verify.
  `kid` Null-terminated key identifier string.
*/
MuseSdkStaticApi MuseSdk_Status MuseSdk_verifySignature(const char* payload, const char* signature, const char* kid);

/**************************************************************************
  Notifications
*/

/*
  Callback function signature.
  `callback_data` is an optional data pointer passed to `MuseSdk_registerCallback`.
  `json` is a JSON message with format {"notifications" : [ {type: string, data: {...}}, {type: string, data: {...}}, ... ] }
  Currently available notifications:
  - {"type": "personal_data_opt_in", "data": {"status": bool} } // user changed the personal data opt-in setting
  - {"type": "samples_location_changed", "data": {"path": string} } // user changed the samples install path
  - {"type": "new_content_installed", "data": { "items" : [ {"path": string}, ... ] } } // new content was installed
  IMPORTANT: the callback should not block and return as soon as possible. Arguments shall not be referenced after return.
  */
typedef void (*NotificationListener)(void* callback_data, const char* json);

/*
  Register/unregister a callback for asynchronous notifications.
  Only one callback per handle allowed, only the last registered callback and filter are used. Pass a null callback to unregister.
  All callbacks are automatically unregistered when releasing the handle.
  `handle` must be a valid handle previously returned by a MuseSdk_initialize call.
  `callback` points to callback function of type NotificationListener.
  `filter` is a comma-separated list of wanted notification types, e.g. `personal_data_opt_in,new_content_installed`, see NotificationListener
  `callback_data` is an optional data pointer passed to the callback as-is.
  IMPORTANT: the callback should not block and return as soon as possible.
*/
MuseSdkApi MuseSdk_Status MuseSdk_registerNotificationListener(MuseSdk_Handle handle, NotificationListener callback, const char* filter, void* callback_data);

/*
  Callback function signature.
  `callback_data` is an optional data pointer passed to `MuseSdk_registerCallback`.
  `message` is specific for each notification type.
  `args` is specific to each message.
  IMPORTANT: the callback should not block and return as soon as possible. Arguments shall not be referenced after return.

  Currently available notifications:
  - message: "Personal data opt-in", args: "0|1" - informs when the user changes the personal data opt-in setting
*/

#ifdef __cplusplus
[[deprecated("NotificationCallback will be removed in a future version. Use NotificationListener with MuseSdk_registerNotificationListener instead.")]]
#endif
typedef void (*NotificationCallback)(void* callback_data, const char* message, const char* args);

/*
  Register/unregister a callback for asynchronous notifications.
  Only one callback per handle allowed, only the last registered callback is used. Pass a null callback to unregister.
  All callbacks are automatically unregistered when releasing the handle.
  `handle` must be a valid handle previously returned by a MuseSdk_initialize call.
  `callback` points to callback function of type NotificationCallback.
  `callback_data` is an optional data pointer passed to the callback as-is.
  IMPORTANT: the callback should not block and return as soon as possible.
*/
#ifdef __cplusplus
[[deprecated("MuseSdk_registerCallback will be removed in a future version. Use MuseSdk_registerNotificationListener instead.")]]
#endif
MuseSdkApi MuseSdk_Status MuseSdk_registerCallback(MuseSdk_Handle handle, NotificationCallback callback, void* callback_data);

#ifdef __cplusplus
}
#endif
