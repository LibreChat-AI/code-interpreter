#define _GNU_SOURCE
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>

static napi_value create_pipe(napi_env env, napi_callback_info info) {
    (void)info;
    int fds[2];
    if (pipe2(fds, O_CLOEXEC) != 0) {
        napi_throw_error(env, NULL, strerror(errno));
        return NULL;
    }
    napi_value array, reader, writer;
    if (napi_create_array_with_length(env, 2, &array) != napi_ok
        || napi_create_int32(env, fds[0], &reader) != napi_ok
        || napi_create_int32(env, fds[1], &writer) != napi_ok
        || napi_set_element(env, array, 0, reader) != napi_ok
        || napi_set_element(env, array, 1, writer) != napi_ok) {
        close(fds[0]); close(fds[1]);
        napi_throw_error(env, NULL, "cannot return anonymous pipe");
        return NULL;
    }
    return array;
}

static napi_value initialize(napi_env env, napi_value exports) {
    napi_value fn;
    if (napi_create_function(env, "createPipe", NAPI_AUTO_LENGTH, create_pipe, NULL, &fn) != napi_ok
        || napi_set_named_property(env, exports, "createPipe", fn) != napi_ok) return NULL;
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
