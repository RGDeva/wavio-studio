/*
* MuseClientSdk
* Copyright 2024 Muse. All rights reserved.
*
* Use, distribution and modification of this code and associated binaries is subject to license.
*/

#pragma once

/*
  SDK messages are authenticated with the following signature algorithm:
  * RSA
    - SHA-256 message digest, a.k.a. RS256
    - Key size 2048 bits
  * Signatures are base64-encoded (may include newlines)
  * Keys are in PEM format (base64-encoded with header)

  Client-side verification:
  - Native implementations can use the provided MuseSdk_verifySignature API and ignore these keys.
    Alternatively, they may use these keys with 3rd party libs like OpenSSL's `RSA_verify`.
  - Electron apps may use these keys with Node.js's `crypto.verify`.
*/

/*
  Public keys
*/

/*
  Test mode (generated on May 13, 2025 14:43)
*/

#define MuseSdk_PublicKeys_TestMode_kid "b294ca20-454d-43a9-98c3-f70ff70bedb7"
#define MuseSdk_PublicKeys_TestMode \
  "-----BEGIN PUBLIC KEY-----\n" \
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAodPlrmTPW+itMsZeD5u/\n" \
  "4Bu9fArgRt3KSWuuTCbKFPs3cQKkI+4QjKUyCD2Il6lw+6+rthqNz2byoEk/0BOg\n" \
  "QclB31/BGzbyMvLjE6qVF5dz8Zh/bfVHKot8C1ho9kS//iuDITqltMMd5FPfCkH5\n" \
  "zFj1vydkKkxJ1RdbC6Puf2RtUhPdABYd4WCkqse6n2NaoZVZjb+9+8sQxWvKaSKX\n" \
  "t0A3MZadBlgzAT5q/SHQLC62400cmFNKBaq95yP5FfKOH1jbt0/bnpWQUQMUxc7r\n" \
  "RGHGWto8HQfifuiXzVPbbc9J/3PPsCZ6BXAL1y7zaWBR6tpo/8DpHjq6yVwM9054\n" \
  "1wIDAQAB\n" \
  "-----END PUBLIC KEY-----\n"

/*
  Production Pool 0..4 (generated on May 27, 2025 10:07)
*/

#define MuseSdk_PublicKeys_0_kid "9ea447ca-9fb9-4072-8b4d-6c0d3220c5fd"
#define MuseSdk_PublicKeys_0 \
  "-----BEGIN PUBLIC KEY-----\n" \
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAySojuMTPknmW3bgZUJNG\n" \
  "5Hejd6lJKHA8K8CPA9Pr1BVhx+PbVuWBPCfZswbDKppil4EZ4NLiKwtqaslQwvBY\n" \
  "vRXg+6l5FE/Fn0/lHkkwrMGHRNyEKVjrxg0JuubsmVcG0thu/ic8bexTH2/w8FbT\n" \
  "e6eKz74nYzeEUOmKYFHSePcuKbOBlJI/ZSLgg4EW5sFVtMoITlwvllvx3Nd0DgUI\n" \
  "afVkceRbY8rPltyuAUfMKounio8gakI41SD4mDCmUKlcDEn0EeO+MJbT3254xTDZ\n" \
  "QciiQKI2bgt1yHO1XGJ3NH16tx9l3ugxw/LUNQ7+vfb79M6zzDgnkc4tNY1i2dak\n" \
  "9QIDAQAB\n" \
  "-----END PUBLIC KEY-----\n"


#define MuseSdk_PublicKeys_1_kid "16418bda-5ecc-4fab-917d-f18cbf637f0f"
#define MuseSdk_PublicKeys_1 \
  "-----BEGIN PUBLIC KEY-----\n" \
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvyP5Bj0a7882FQZiJQDD\n" \
  "fmxvzKj1iaECbTTtff5J3AbMqVW7HNvM71Tpvwkea6voOXrcqbnQMv0PClj+spFc\n" \
  "mW+w6aYIpusX63cxRd0mOx5CavkbAIcZU5vQa8ic6g7f59w2vpw6WCja6km/Zdkl\n" \
  "HtOdNW5Kz3S/QjlXfUfmMa589BGMdT9N80vwmy3vaoPQrQ0JVsGFSE1Zghx0gJfJ\n" \
  "3j9pC/kfhHRmp49DAYQO+cYNehLMuzxSchfPqCSh8teYubg/UkPDYO00Ks42d+wM\n" \
  "dl5Gm0Em+HoiNL4Wr8blVLeNEhMP+xue40sCTe5guIlb9YAK9r2ukzNG0a4KupIu\n" \
  "+QIDAQAB\n" \
  "-----END PUBLIC KEY-----\n"


#define MuseSdk_PublicKeys_2_kid "c69d4fd7-4d0f-4103-a1f3-790e71c45b78"
#define MuseSdk_PublicKeys_2 \
  "-----BEGIN PUBLIC KEY-----\n" \
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyRuT7OiBUGt8lIv+sHoN\n" \
  "jAS0ZJ3BAKnwry88EmjwbrxtWvWLyLrDpd+/rH2xOAiXZ7KxNPEYOTe+Id0X0thZ\n" \
  "z52ebJBfFxBpfWRmlzXXggSemwH8IKr6BIsXeNmg/mHp7VNGfNRVNanzhwLXunxv\n" \
  "s4XKT5L7KOOYSanaNY+lJ4pNq2FKJlyTHaCOGZPplydevCGt7kVimb7N+4dU3sJf\n" \
  "u9pGelRuhxvrahPkMXqebiV9pQ0SP0EiWnqrjmdREQrlwxomZZtvfSejHEoORQEH\n" \
  "Q4kV6K9Zu8kpo8O55CtIu8Gh6G+8fwBK4g0rKiQoM/2SBM8RCRqepwIqTl1gVPpe\n" \
  "pQIDAQAB\n" \
  "-----END PUBLIC KEY-----\n"


#define MuseSdk_PublicKeys_3_kid "d8148d75-5726-43c9-9cab-dc228b7bb2db"
#define MuseSdk_PublicKeys_3 \
  "-----BEGIN PUBLIC KEY-----\n" \
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjTETouU1qJWfoTC5CYZW\n" \
  "ZA4gJ8DERt0Ehc4TrUzjJ7SDfk/fPw2L2jz8YXVq0wxGGVUFP+oyvIW3CkBtiMHZ\n" \
  "BjhejiNC5+uRnVPgSFHPIPcspO58r+4If4y976VvskXyf+i1y8nMOu3wT+hqhHU9\n" \
  "M50RgkOCNyUwPh5RONOk6VCN9MVnItkCwFOXOJAiTfBDt1YSUiiRzt1PazaH9Yil\n" \
  "F03BsTIiBo+vEVLAdCufLUGf5obdF3lQTQZusOggJHWQyVLVLRqxMH6yggwN55UQ\n" \
  "mut4dfz2X+z9Cu5hr+2Icqt8u/jJdPJls2ta1vb9XBf90s7oCRkoKVX+v/sHUske\n" \
  "9wIDAQAB\n" \
  "-----END PUBLIC KEY-----\n"


#define MuseSdk_PublicKeys_4_kid "61986ea9-0fdd-4f84-8329-6ec844b776cb"
#define MuseSdk_PublicKeys_4 \
  "-----BEGIN PUBLIC KEY-----\n" \
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3qI6a3+79qCEQz8qDXj3\n" \
  "5qeKXPyddmhAhSboHo+Gc6mYBbU5aRXnxTsmAHijjG9DP2aSfkVSnq00cVF3XwNJ\n" \
  "4l9dQhjNIM4ZAUUVseU5cVTXJwWodx+U5PNQtQsLI6SbMC5aNRyDoZNLoXUOfi7D\n" \
  "q3C10CQxGMrlzAY1W6A8VbgXi8BfXMcrMa/5BOy3oC3TH8yhy6JSsgfcWs+91lf2\n" \
  "VSO4P45jPvCaQ9aLj6mr4YYfCJmZa4VejBdqCoV8rCJB3gfGCPrOt/E4eWpXm+1a\n" \
  "ZYlQsiIMgLj4U1FmBnSmmvcNjmV6W1kk5+c3wE6ExDUopMVyi1sdE2oP2sqJQNUO\n" \
  "zwIDAQAB\n" \
  "-----END PUBLIC KEY-----\n"

