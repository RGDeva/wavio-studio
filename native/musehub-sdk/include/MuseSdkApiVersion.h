/*
 * MuseClientSdk
 * Copyright 2025 Muse. All rights reserved.
 *
 * Use, distribution and modification of this code and associated binaries is subject to license.
 */

#pragma once

/*
  This header file provides macros and definitions that specify the version numbers for both the
  SDK API and the associated binary files.
*/

#define MUSESDK_VERSION_MAJOR 1
#define MUSESDK_VERSION_MINOR 5
#define MUSESDK_VERSION_REVIS 1

#define MUSESDK_VERSION_STR2(a, b, c) #a "." #b "." #c
#define MUSESDK_VERSION_STR(a, b, c) MUSESDK_VERSION_STR2(a, b, c)
#define MUSESDK_VERSION_STRING MUSESDK_VERSION_STR(MUSESDK_VERSION_MAJOR, MUSESDK_VERSION_MINOR, MUSESDK_VERSION_REVIS)
#define MUSESDK_LIB_NAME "MuseClientSdk." MUSESDK_VERSION_STRING

/*
  Version History

  * 1.5.1
    - More private productSpecificRequest APIs.
    - MuseSdk_Status_DLL_NOT_LOADED return status when the SDK DLL is not resolved on Windows.

  * 1.5.0
    - Support for Private API: added productSpecificRequest.

  * 1.4.0
    - Support for Product API: added getProductApiData.

  * 1.3.0
    - Added getReceipt returning a cryptographically signed receipt of the purchased licenses.
    - Deprecated getActivationStatus in favour of getReceipt.
    - Cryptographic functions provided as statically linked library for independent verification of recepits.
    - Windows: lazy loading of DLL upon first use (attempt caller's path first, then PATH), instead of static linkage.

  * 1.2.0
    - Added getSamplesInstallLocation API returning the samples install location and a samples_location_changed notification.
    - Added new_content_installed callback, notifying clients when the user successfully installs new content.
    - Added a more versatile Listener interface deprecating NotificationCallback
    - Misc improvements and fixes, including improved support for many concurrent clients

  * 1.1.1
    - Launch Hub in the background: drop attempt if there's no registered handler (prevents unwated OS popups)

  * 1.1.0
    - Added personal user data to getUserInfo (user must opt-in for the data to be shared)
    - Added requestPersonalDataOptin API
    - Added callbacks for Hub->SDK notifications
    - Launch Hub in the background if it is not running when attempting connection

  * 1.0.2
    - Fixed a rare conflict between the Windows SDK and applications built with older MSVCRT runtimes
    - Added bindings for Electron applications

*/

/* CI build e95a345aa5fccd3ed5e1f6c33c4b70e838925e83 - 2026-02-05 10:00:33 UTC */
