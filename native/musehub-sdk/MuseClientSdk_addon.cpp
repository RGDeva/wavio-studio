/*
 * MuseClientSdk
 * Copyright 2025 Muse. All rights reserved.
 *
 * Add-on to bind the C SDK to a node.js application.
 *
 */

#include <node.h>
#include <uv.h>

#include "MuseClientSdkApi.h"


void initializeTestMode(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::HandleScope scope(isolate);

    if (args.Length() != 1 || !args[0]->IsBoolean()) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    bool mock_user = args[0]->BooleanValue(isolate);
    MuseSdk_Handle handle;
    MuseSdk_Status status = MuseSdk_initializeTestMode(mock_user, &handle);

    v8::Local<v8::Object> result = v8::Object::New(isolate);
    result->Set(isolate->GetCurrentContext(), v8::String::NewFromUtf8(isolate, "status").ToLocalChecked(),
        v8::Number::New(isolate, status));
    result->Set(isolate->GetCurrentContext(), v8::String::NewFromUtf8(isolate, "handle").ToLocalChecked(),
        v8::Number::New(isolate, reinterpret_cast<uint64_t>(handle)));

    args.GetReturnValue().Set(result);
}

void initializeElectron(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::HandleScope scope(isolate);

    if (args.Length() != 1 || !args[0]->IsString()) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    v8::String::Utf8Value str(args.GetIsolate(), args[0]);
    if (*str == nullptr) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }
    const char* cstr = *str;

    MuseSdk_Handle handle{};
    MuseSdk_Status status = MuseSdk_initializeElectron(&handle, cstr);

    v8::Local<v8::Object> result = v8::Object::New(isolate);
    result->Set(isolate->GetCurrentContext(), v8::String::NewFromUtf8(isolate, "status").ToLocalChecked(),
        v8::Number::New(isolate, status));
    result->Set(isolate->GetCurrentContext(), v8::String::NewFromUtf8(isolate, "handle").ToLocalChecked(),
        v8::Number::New(isolate, reinterpret_cast<uint64_t>(handle)));

    args.GetReturnValue().Set(result);
}

void finalize(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::HandleScope scope(isolate);

    if (args.Length() != 1 || !args[0]->IsNumber()) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    uint64_t handle_arg = args[0]->IntegerValue(isolate->GetCurrentContext()).FromJust();
    MuseSdk_Handle handle = reinterpret_cast<MuseSdk_Handle>(handle_arg);

    MuseSdk_Status status = MuseSdk_finalize(&handle);

    args.GetReturnValue().Set(v8::Number::New(isolate, status));
}

void getUserInfo(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::HandleScope scope(isolate);

    if (args.Length() != 1 || !args[0]->IsNumber()) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    uint64_t handle_arg = args[0]->IntegerValue(isolate->GetCurrentContext()).FromJust();
    MuseSdk_Handle handle = reinterpret_cast<MuseSdk_Handle>(handle_arg);

    MuseSdk_UserInfo* data{};
    MuseSdk_Status status = MuseSdk_getUserInfo(handle, &data);

    v8::Local<v8::Object> result = v8::Object::New(isolate);
    result->Set(isolate->GetCurrentContext(), v8::String::NewFromUtf8(isolate, "status").ToLocalChecked(),
        v8::Number::New(isolate, status));

    if (status == MuseSdk_Status_SUCCESS) {
        v8::Local<v8::Object> info_obj = v8::Object::New(isolate);
        info_obj->Set(isolate->GetCurrentContext(),
            v8::String::NewFromUtf8(isolate, "uuid").ToLocalChecked(),
            v8::String::NewFromUtf8(isolate, data->uuid).ToLocalChecked());

        if (data->email)
            info_obj->Set(isolate->GetCurrentContext(),
                v8::String::NewFromUtf8(isolate, "email").ToLocalChecked(),
                v8::String::NewFromUtf8(isolate, data->email).ToLocalChecked());

        if (data->name)
            info_obj->Set(isolate->GetCurrentContext(),
                v8::String::NewFromUtf8(isolate, "name").ToLocalChecked(),
                v8::String::NewFromUtf8(isolate, data->name).ToLocalChecked());

        if (data->picture_url)
            info_obj->Set(isolate->GetCurrentContext(),
                v8::String::NewFromUtf8(isolate, "picture_url").ToLocalChecked(),
                v8::String::NewFromUtf8(isolate, data->picture_url).ToLocalChecked());

        result->Set(isolate->GetCurrentContext(),
            v8::String::NewFromUtf8(isolate, "userInfo").ToLocalChecked(),
            info_obj);

        MuseSdk_releaseUserInfo(&data);
    }
    else {
        args.GetReturnValue().Set(v8::Number::New(isolate, status));
    }

    args.GetReturnValue().Set(result);
}

void requestPersonalDataOptin(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::HandleScope scope(isolate);

    if (args.Length() != 1 || !args[0]->IsNumber()) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    MuseSdk_Handle handle = reinterpret_cast<MuseSdk_Handle>(args[0]->IntegerValue(isolate->GetCurrentContext()).ToChecked());
    MuseSdk_Status status = MuseSdk_requestPersonalDataOptin(handle);

    v8::Local<v8::Object> result = v8::Object::New(isolate);
    result->Set(isolate->GetCurrentContext(), v8::String::NewFromUtf8(isolate, "status").ToLocalChecked(),
        v8::Number::New(isolate, status));
    args.GetReturnValue().Set(result);
}

void getSku(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::HandleScope scope(isolate);

    if (args.Length() != 1 || !args[0]->IsNumber()) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    uint64_t handle_arg = args[0]->IntegerValue(isolate->GetCurrentContext()).FromJust();
    MuseSdk_Handle handle = reinterpret_cast<MuseSdk_Handle>(handle_arg);

    MuseSdk_Sku* data{};
    MuseSdk_Status status = MuseSdk_getSku(handle, &data);

    v8::Local<v8::Object> result = v8::Object::New(isolate);
    result->Set(isolate->GetCurrentContext(), v8::String::NewFromUtf8(isolate, "status").ToLocalChecked(),
        v8::Number::New(isolate, status));

    if (status == MuseSdk_Status_SUCCESS) {
        v8::Local<v8::Object> info_obj = v8::Object::New(isolate);
        info_obj->Set(isolate->GetCurrentContext(),
            v8::String::NewFromUtf8(isolate, "sku").ToLocalChecked(),
            v8::String::NewFromUtf8(isolate, data->sku).ToLocalChecked());

        result->Set(isolate->GetCurrentContext(),
            v8::String::NewFromUtf8(isolate, "sku").ToLocalChecked(),
            info_obj);

        MuseSdk_releaseSku(&data);
    }

    args.GetReturnValue().Set(result);
}

void getSubscriptionOption(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::HandleScope scope(isolate);

    if (args.Length() != 1 || !args[0]->IsNumber()) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    uint64_t handle_arg = args[0]->IntegerValue(isolate->GetCurrentContext()).FromJust();
    MuseSdk_Handle handle = reinterpret_cast<MuseSdk_Handle>(handle_arg);

    MuseSdk_SubscriptionOption* data{};
    MuseSdk_Status status = MuseSdk_getSubscriptionOption(handle, &data);

    v8::Local<v8::Object> result = v8::Object::New(isolate);
    result->Set(isolate->GetCurrentContext(), v8::String::NewFromUtf8(isolate, "status").ToLocalChecked(),
        v8::Number::New(isolate, status));

    if (status == MuseSdk_Status_SUCCESS) {
        v8::Local<v8::Object> info_obj = v8::Object::New(isolate);
        info_obj->Set(isolate->GetCurrentContext(),
            v8::String::NewFromUtf8(isolate, "assignedId").ToLocalChecked(),
            v8::String::NewFromUtf8(isolate, data->assigned_id).ToLocalChecked());

        result->Set(isolate->GetCurrentContext(),
            v8::String::NewFromUtf8(isolate, "subscriptionOption").ToLocalChecked(),
            info_obj);

        MuseSdk_releaseSubscriptionOption(&data);
    }
    else {
        args.GetReturnValue().Set(v8::Number::New(isolate, status));
    }

    args.GetReturnValue().Set(result);
}

void getActivationStatus(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::HandleScope scope(isolate);

    if (args.Length() != 1 || !args[0]->IsNumber()) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    uint64_t handle_arg = args[0]->IntegerValue(isolate->GetCurrentContext()).FromJust();
    MuseSdk_Handle handle = reinterpret_cast<MuseSdk_Handle>(handle_arg);

    MuseSdk_ActivationStatus data;
    MuseSdk_Status status = MuseSdk_getActivationStatus(handle, &data);

    v8::Local<v8::Object> result = v8::Object::New(isolate);
    result->Set(isolate->GetCurrentContext(), v8::String::NewFromUtf8(isolate, "status").ToLocalChecked(),
        v8::Number::New(isolate, status));

    if (status == MuseSdk_Status_SUCCESS) {
        result->Set(isolate->GetCurrentContext(), v8::String::NewFromUtf8(isolate, "activationStatus").ToLocalChecked(),
            v8::Number::New(isolate, data));
    }
    else {
        args.GetReturnValue().Set(v8::Number::New(isolate, status));
    }

    args.GetReturnValue().Set(result);
}

void getSamplesInstallLocation(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::HandleScope scope(isolate);

    if (args.Length() != 1 || !args[0]->IsNumber()) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    uint64_t handle_arg = args[0]->IntegerValue(isolate->GetCurrentContext()).FromJust();
    MuseSdk_Handle handle = reinterpret_cast<MuseSdk_Handle>(handle_arg);

    MuseSdk_StorageLocation* data{};
    MuseSdk_Status status = MuseSdk_getSamplesInstallLocation(handle, &data);

    v8::Local<v8::Object> result = v8::Object::New(isolate);
    result->Set(isolate->GetCurrentContext(), v8::String::NewFromUtf8(isolate, "status").ToLocalChecked(),
        v8::Number::New(isolate, status));

    if (status == MuseSdk_Status_SUCCESS) {
        v8::Local<v8::Object> info_obj = v8::Object::New(isolate);
        info_obj->Set(isolate->GetCurrentContext(),
            v8::String::NewFromUtf8(isolate, "path").ToLocalChecked(),
            v8::String::NewFromUtf8(isolate, data->path).ToLocalChecked());

        result->Set(isolate->GetCurrentContext(),
            v8::String::NewFromUtf8(isolate, "storageLocation").ToLocalChecked(),
            info_obj);

        MuseSdk_releaseSamplesInstallLocation(&data);
    }
    else {
        args.GetReturnValue().Set(v8::Number::New(isolate, status));
    }

    args.GetReturnValue().Set(result);
}

void getReceipt(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::HandleScope scope(isolate);

    if (args.Length() != 1 || !args[0]->IsNumber()) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    uint64_t handle_arg = args[0]->IntegerValue(isolate->GetCurrentContext()).FromJust();
    MuseSdk_Handle handle = reinterpret_cast<MuseSdk_Handle>(handle_arg);

    MuseSdk_Receipt* data{};
    MuseSdk_Status status = MuseSdk_getReceipt(handle, &data);

    v8::Local<v8::Object> result = v8::Object::New(isolate);
    result->Set(isolate->GetCurrentContext(), v8::String::NewFromUtf8(isolate, "status").ToLocalChecked(),
        v8::Number::New(isolate, status));

    if (status == MuseSdk_Status_SUCCESS) {
        v8::Local<v8::Object> info_obj = v8::Object::New(isolate);

        // Parse the JSON receipt into a v8::Object
        v8::Local<v8::String> json_str = v8::String::NewFromUtf8(isolate, data->receipt).ToLocalChecked();
        v8::Local<v8::Value> json_obj;
        if (!v8::JSON::Parse(isolate->GetCurrentContext(), json_str).ToLocal(&json_obj)) {
            json_obj = json_str; // fallback to string
        }

        info_obj->Set(isolate->GetCurrentContext(),
            v8::String::NewFromUtf8(isolate, "receipt").ToLocalChecked(),
            json_obj);

        result->Set(isolate->GetCurrentContext(),
            v8::String::NewFromUtf8(isolate, "receipt").ToLocalChecked(),
            info_obj);

        MuseSdk_releaseReceipt(&data);
    }

    args.GetReturnValue().Set(result);
}

void getProductApiData(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::HandleScope scope(isolate);

    if (args.Length() != 3 || !args[0]->IsNumber() || !args[1]->IsString() || !args[2]->IsString()) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    uint64_t handle_arg = args[0]->IntegerValue(isolate->GetCurrentContext()).FromJust();
    MuseSdk_Handle handle = reinterpret_cast<MuseSdk_Handle>(handle_arg);

    v8::String::Utf8Value client_secret(isolate, args[1]);
    v8::String::Utf8Value api_product_id(isolate, args[2]);
    if (*client_secret == nullptr || *api_product_id == nullptr) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    MuseSdk_ProductApiData* data{};
    MuseSdk_Status status = MuseSdk_getProductApiData(handle, *client_secret, *api_product_id, &data);

    v8::Local<v8::Object> result = v8::Object::New(isolate);
    result->Set(isolate->GetCurrentContext(), v8::String::NewFromUtf8(isolate, "status").ToLocalChecked(),
        v8::Number::New(isolate, status));

    if (status == MuseSdk_Status_SUCCESS) {
        v8::Local<v8::Object> info_obj = v8::Object::New(isolate);

        // Parse the JSON data into a v8::Object
        v8::Local<v8::String> json_str = v8::String::NewFromUtf8(isolate, data->data).ToLocalChecked();
        v8::Local<v8::Value> json_obj;
        if (!v8::JSON::Parse(isolate->GetCurrentContext(), json_str).ToLocal(&json_obj)) {
            json_obj = json_str; // fallback to string
        }

        info_obj->Set(isolate->GetCurrentContext(),
            v8::String::NewFromUtf8(isolate, "data").ToLocalChecked(),
            json_obj);

        result->Set(isolate->GetCurrentContext(),
            v8::String::NewFromUtf8(isolate, "productApiData").ToLocalChecked(),
            info_obj);

        MuseSdk_releaseProductApiData(&data);
    }
    args.GetReturnValue().Set(result);
}

void productSpecificRequest(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::HandleScope scope(isolate);

    if (args.Length() != 2 || !args[0]->IsNumber() || !args[1]->IsString()) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    uint64_t handle_arg = args[0]->IntegerValue(isolate->GetCurrentContext()).FromJust();
    MuseSdk_Handle handle = reinterpret_cast<MuseSdk_Handle>(handle_arg);

    v8::String::Utf8Value request(isolate, args[1]);
    if (*request == nullptr) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }
    const char* request_cstr = *request;

    MuseSdk_ProductSpecificResponse* data{};
    MuseSdk_Status status = MuseSdk_productSpecificRequest(handle, request_cstr, &data);

    v8::Local<v8::Object> result = v8::Object::New(isolate);
    result->Set(isolate->GetCurrentContext(), v8::String::NewFromUtf8(isolate, "status").ToLocalChecked(),
        v8::Number::New(isolate, status));

    if (status == MuseSdk_Status_SUCCESS) {
        v8::Local<v8::Object> info_obj = v8::Object::New(isolate);

        // Parse the JSON data into a v8::Object
        v8::Local<v8::String> json_str = v8::String::NewFromUtf8(isolate, data->data).ToLocalChecked();
        v8::Local<v8::Value> json_obj;
        if (!v8::JSON::Parse(isolate->GetCurrentContext(), json_str).ToLocal(&json_obj)) {
            json_obj = json_str; // fallback to string
        }

        info_obj->Set(isolate->GetCurrentContext(),
            v8::String::NewFromUtf8(isolate, "data").ToLocalChecked(),
            json_obj);

        result->Set(isolate->GetCurrentContext(),
            v8::String::NewFromUtf8(isolate, "response").ToLocalChecked(),
            info_obj);

        MuseSdk_releaseProductSpecificResponse(&data);
    }

    args.GetReturnValue().Set(result);
}

void registerCallback(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::HandleScope scope(isolate);

    if (args.Length() != 2 || !args[0]->IsNumber() || !args[1]->IsFunction()) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    MuseSdk_Handle handle = reinterpret_cast<MuseSdk_Handle>(args[0]->IntegerValue(isolate->GetCurrentContext()).ToChecked());
    v8::Local<v8::Function> callback = v8::Local<v8::Function>::Cast(args[1]);

    v8::Persistent<v8::Function>* persistentCallback = new v8::Persistent<v8::Function>(isolate, callback);

    auto jsCallback = [](void* data, const char* message, const char* args) {
        auto* callback = static_cast<v8::Persistent<v8::Function>*>(data);

        // Queue the callback to run in Node's event loop
        uv_async_t* async = new uv_async_t;
        struct AsyncData {
            v8::Persistent<v8::Function>* callback;
            std::string message;
            std::string args;
        };

        AsyncData* asyncData = new AsyncData{ callback, message, args };
        async->data = asyncData;

        uv_async_init(uv_default_loop(), async, [](uv_async_t* handle) {
            v8::Isolate* isolate = v8::Isolate::GetCurrent();
            v8::HandleScope scope(isolate);

            AsyncData* data = static_cast<AsyncData*>(handle->data);
            v8::Local<v8::Function> callback = v8::Local<v8::Function>::New(isolate, *data->callback);
            v8::Local<v8::Value> argv[] = {
                v8::String::NewFromUtf8(isolate, data->message.c_str()).ToLocalChecked(),
                v8::String::NewFromUtf8(isolate, data->args.c_str()).ToLocalChecked()
            };
            callback->Call(isolate->GetCurrentContext(), v8::Null(isolate), 2, argv);

            delete data;
            uv_close((uv_handle_t*)handle, [](uv_handle_t* handle) { delete handle; });
            });

        uv_async_send(async);
        };

    MuseSdk_Status status = MuseSdk_registerCallback(handle, jsCallback, persistentCallback);
    args.GetReturnValue().Set(v8::Number::New(isolate, status));
}

void registerNotificationListener(const v8::FunctionCallbackInfo<v8::Value>& args) {
    v8::Isolate* isolate = args.GetIsolate();
    v8::HandleScope scope(isolate);

    if (args.Length() != 3 || !args[0]->IsNumber() || (!args[1]->IsFunction() && !args[1]->IsNull()) || !args[2]->IsString()) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }

    MuseSdk_Handle handle = reinterpret_cast<MuseSdk_Handle>(args[0]->IntegerValue(isolate->GetCurrentContext()).ToChecked());

    // Extract callback function (can be null)
    v8::Persistent<v8::Function>* persistentCallback = nullptr;
    NotificationListener jsCallback = nullptr;
    if (!args[1]->IsNull()) {
        // If the callback is not null, create a persistent handle for it
        v8::Local<v8::Function> callback = v8::Local<v8::Function>::Cast(args[1]);
        persistentCallback = new v8::Persistent<v8::Function>(isolate, callback);

        jsCallback = [](void* data, const char* json) {
            auto* callback = static_cast<v8::Persistent<v8::Function>*>(data);

            uv_async_t* async = new uv_async_t;
            struct AsyncData {
                v8::Persistent<v8::Function>* callback;
                std::string json;
            };

            AsyncData* asyncData = new AsyncData{ callback, json };
            async->data = asyncData;

            uv_async_init(uv_default_loop(), async, [](uv_async_t* handle) {
                v8::Isolate* isolate = v8::Isolate::GetCurrent();
                v8::HandleScope scope(isolate);

                AsyncData* data = static_cast<AsyncData*>(handle->data);
                v8::Local<v8::Function> callback = v8::Local<v8::Function>::New(isolate, *data->callback);
#if 0
                // Send the JSON string as-is
                v8::Local<v8::Value> argv[] = {
                    v8::String::NewFromUtf8(isolate, data->json.c_str()).ToLocalChecked()
                };
                callback->Call(isolate->GetCurrentContext(), v8::Null(isolate), 1, argv);
#else
                // Send the JSON parsed into a v8::Object
                v8::Local<v8::String> json_str = v8::String::NewFromUtf8(isolate, data->json.c_str()).ToLocalChecked();
                v8::Local<v8::Value> json_obj;
                if (v8::JSON::Parse(isolate->GetCurrentContext(), json_str).ToLocal(&json_obj)) {
                    // If parsing succeeds, call the callback with the parsed JSON object
                    v8::Local<v8::Value> argv[] = {
                        json_obj
                    };
                    callback->Call(isolate->GetCurrentContext(), v8::Null(isolate), 1, argv);
                }
#endif
                delete data;
                uv_close((uv_handle_t*)handle, [](uv_handle_t* handle) { delete handle; });
                });

            uv_async_send(async);
            };
    }

    v8::String::Utf8Value filter(isolate, args[2]);
    if (*filter == nullptr) {
        args.GetReturnValue().Set(v8::Number::New(isolate, MuseSdk_Status_INVALID_ARGS));
        return;
    }
    const char* filter_cstr = *filter;

    // Register or unregister the callback with the C API
    MuseSdk_Status status = MuseSdk_registerNotificationListener(handle, jsCallback, filter_cstr, persistentCallback);
    args.GetReturnValue().Set(v8::Number::New(isolate, status));
}


// ----------------------------------------------------------------------------

void declareAddon(v8::Local<v8::Object> exports) {
    v8::Isolate* isolate = exports->GetIsolate();
    v8::Local<v8::Context> context = isolate->GetCurrentContext();

    // Export add-on functions
    const std::vector<std::pair<const char*, v8::FunctionCallback>> functions = {
        {"initializeTestMode", initializeTestMode},
        {"initializeElectron", initializeElectron},
        {"finalize", finalize},
        {"getUserInfo", getUserInfo},
        {"requestPersonalDataOptin", requestPersonalDataOptin},
        {"getSku", getSku},
        {"getSubscriptionOption", getSubscriptionOption},
        {"getActivationStatus", getActivationStatus},
        {"getSamplesInstallLocation", getSamplesInstallLocation},
        {"getReceipt", getReceipt},
        {"getProductApiData", getProductApiData},
        {"productSpecificRequest", productSpecificRequest},
        {"registerCallback", registerCallback},
        {"registerNotificationListener", registerNotificationListener},
    };

    for (auto& func : functions) {
        exports->Set(context,
            v8::String::NewFromUtf8(isolate, func.first).ToLocalChecked(),
            v8::FunctionTemplate::New(isolate, func.second)->GetFunction(context).ToLocalChecked());
    }
}

NODE_MODULE(NODE_GYP_MODULE_NAME, declareAddon)
