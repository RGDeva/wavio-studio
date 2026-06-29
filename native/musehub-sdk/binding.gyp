{
  "targets": [
    {
      "target_name": "MuseClientSdk",
      "sources": [ "MuseClientSdk_addon.cpp" ],
      "include_dirs": [
        "<(module_root_dir)/include/",
      ],
      "conditions": [
        [
          "OS==\"win\"",
          {
            "libraries": [
              "<(module_root_dir)/bin/win64/MuseClientSdk.1.5.1.lib"
            ],
            "product_dir": "<(module_root_dir)/win",
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": []
              }
            }
          }
        ],
        [
          "OS==\"mac\"",
          {
            "libraries": [
              "<(module_root_dir)/bin/macos_universal/libMuseClientSdk.1.5.1.dylib"
            ],
            "product_dir": "<(module_root_dir)/mac",
            "xcode_settings": {
              "OTHER_CFLAGS": [
                "-arch x86_64",
                "-arch arm64"
              ],
              "OTHER_LDFLAGS": ["-Wl,-rpath,@loader_path/",
                "-arch x86_64", "-arch arm64",
                "-s", "-Wl,-S" # stripping
                ]
            }
          }
        ]
      ]
    }
  ]
}
