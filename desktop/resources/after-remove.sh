#!/bin/bash

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

unload_apparmor_profile() {
    local dst="$1"
    if [ -f "$dst" ]; then
        if apparmor_status --enabled > /dev/null 2>&1; then
            if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
                apparmor_parser --remove "$dst" || true
            fi
        fi
        rm -f "$dst"
    fi
}

unload_apparmor_profile '/etc/apparmor.d/${executable}'
unload_apparmor_profile '/etc/apparmor.d/opensuperbot-bwrap'
