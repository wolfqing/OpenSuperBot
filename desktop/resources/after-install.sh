#!/bin/bash

if type update-alternatives >/dev/null 2>&1; then
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install AppArmor profiles on Ubuntu 24.04+ (ABI 4.0); older systems (e.g. Ubuntu 22.04) skip cleanly.
# Note: electron-builder interpolates brace-wrapped names in this script, so shell variables stay unbraced.
load_apparmor_profile() {
    local src="$1"
    local dst="$2"
    if [ -f "$src" ] && apparmor_parser --skip-kernel-load --debug "$src" > /dev/null 2>&1; then
        cp -f "$src" "$dst"
        if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
            apparmor_parser --replace --write-cache --skip-read-cache "$dst" || true
        fi
    fi
}

if apparmor_status --enabled > /dev/null 2>&1; then
    load_apparmor_profile '/opt/${sanitizedProductName}/resources/apparmor-profile' '/etc/apparmor.d/${executable}'

    # Only add a profile for /usr/bin/bwrap when no other file in /etc/apparmor.d already covers it
    # (two profiles targeting the same binary path conflict in AppArmor).
    BWRAP_COVERED=0
    for f in /etc/apparmor.d/*; do
        [ -f "$f" ] || continue
        [ "$f" = '/etc/apparmor.d/opensuperbot-bwrap' ] && continue
        if grep -qs '/usr/bin/bwrap' "$f" 2>/dev/null; then
            BWRAP_COVERED=1
            break
        fi
    done
    if [ "$BWRAP_COVERED" -eq 0 ]; then
        load_apparmor_profile '/opt/${sanitizedProductName}/resources/apparmor-bwrap' '/etc/apparmor.d/opensuperbot-bwrap'
    fi
fi
