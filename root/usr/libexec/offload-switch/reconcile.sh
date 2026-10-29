#!/bin/sh
#
# Single source of truth for luci-app-offload-switch.
#
# Reads the desired goal from /etc/config/offload (mode: statistics|accelerate)
# and maps it onto every traffic accelerator:
#   - netfilter flowtable        (firewall.@defaults[0].flow_offloading[_hw])
#   - Qualcomm NSS/ECM           (/etc/init.d/qca-nss-ecm start|stop)
#   - Qualcomm Wi-Fi NSS offload (ath11k nss_offload, persisted for next boot)
#
# Emits machine-readable result lines, useful when running it by hand:
#   ACTION: <what changed>
#   NOTE:   <warning / caveat>
#   REBOOT_REQUIRED: <reason>    (a change that only takes effect after reboot)
#
# It is triggered at boot (START=95) and whenever /etc/config/offload is
# committed, through the ucitrack config trigger.
#
# Safe to run repeatedly and at boot: it only touches state that differs from
# the target, so it will not needlessly tear down live accelerated flows.

. /lib/functions.sh

CONFIG=offload
ECM_INIT=/etc/init.d/qca-nss-ecm
ATH11K_MODFILE=/etc/modules.d/ath11k
ATH11K_PARAM=/sys/module/ath11k/parameters/nss_offload

log_action() { echo "ACTION: $1"; }
log_note()   { echo "NOTE: $1"; }
log_reboot() { echo "REBOOT_REQUIRED: $1"; }

uci_get() { uci -q get "$1" 2>/dev/null; }

ecm_present() { [ -x "$ECM_INIT" ]; }
ecm_active()  { [ -d /sys/module/ecm ]; }

fullcone_enabled() {
	[ "$(uci_get firewall.@defaults[0].fullcone)" = 1 ] && return 0
	fullcone_found=1
	config_load firewall
	config_foreach _fullcone_zone zone
	return $fullcone_found
}

_fullcone_zone() {
	local fc
	config_get fc "$1" fullcone
	[ "$fc" = 1 ] && fullcone_found=0
	return 0
}

# --- firewall flowtable --------------------------------------------------
# $1: desired value for software+hardware flowtable (0|1)
set_flowtable() {
	local want="$1"
	local cur cur_hw
	cur=$(uci_get firewall.@defaults[0].flow_offloading)
	cur_hw=$(uci_get firewall.@defaults[0].flow_offloading_hw)

	[ "$cur" = "$want" ] && [ "$cur_hw" = "$want" ] && return 0

	uci -q set firewall.@defaults[0].flow_offloading="$want"
	uci -q set firewall.@defaults[0].flow_offloading_hw="$want"
	uci -q commit firewall

	# A shell `uci commit` does not raise the procd config.change event, so the
	# firewall has to be reloaded here for the new flowtable flags to take
	# effect at runtime.
	flowtable_changed=1

	if [ "$want" = 1 ]; then
		log_action "flowtable offload enabled (software + hardware)"
	else
		log_action "flowtable offload disabled"
	fi
}

# --- Qualcomm NSS/ECM ----------------------------------------------------
# $1: desired state (0|1)
set_ecm() {
	local want="$1"

	# Keep the boot-time rc.d state in sync so a reboot starts clean. Note the
	# vendor qca-nss-pbuf init (START=27) can still re-arm the engine on boot
	# through its ensure_ecm_redirect() helper, which calls qca-nss-ecm start
	# directly and ignores the rc.d link; offload-switch (START=95) runs after
	# it and re-asserts the goal.
	if [ "$want" = 1 ]; then
		$ECM_INIT enabled >/dev/null 2>&1 || $ECM_INIT enable >/dev/null 2>&1
	else
		$ECM_INIT enabled >/dev/null 2>&1 && $ECM_INIT disable >/dev/null 2>&1
	fi

	if [ "$want" = 1 ]; then
		if ! ecm_active; then
			$ECM_INIT start >/dev/null 2>&1
			log_action "NSS/ECM engine started"
		fi
	else
		if ecm_active; then
			$ECM_INIT stop >/dev/null 2>&1
			log_action "NSS/ECM engine stopped (accelerated flows flushed)"
		fi
	fi
}

# --- Qualcomm Wi-Fi NSS offload (ath11k) ---------------------------------
# ath11k copies the nss_offload module parameter into each radio only while the
# module initialises, so it cannot be toggled on a running driver. We persist
# the desired value into /etc/modules.d/ath11k and ask for a reboot when the
# running value still differs.
ath11k_present() {
	[ -f "$ATH11K_MODFILE" ] || [ -e "$ATH11K_PARAM" ]
}

ath11k_persist_value() {
	[ -r "$ATH11K_MODFILE" ] || return 1
	sed -n 's/.*nss_offload=\([0-9][0-9]*\).*/\1/p' "$ATH11K_MODFILE" | head -n 1
}

ath11k_runtime_value() {
	[ -r "$ATH11K_PARAM" ] || return 1
	tr -d '[:space:]' < "$ATH11K_PARAM"
}

# $1: desired state (0|1)
set_ath11k() {
	local want="$1" cur rt
	ath11k_present || return 0

	if [ -w "$ATH11K_MODFILE" ]; then
		cur=$(ath11k_persist_value)
		if [ "$cur" != "$want" ]; then
			if grep -q 'nss_offload=' "$ATH11K_MODFILE" 2>/dev/null; then
				sed -i "s/nss_offload=[0-9][0-9]*/nss_offload=$want/" "$ATH11K_MODFILE"
			else
				sed -i "1s/\$/ nss_offload=$want/" "$ATH11K_MODFILE"
			fi
			if [ "$want" = 1 ]; then
				log_action "Wi-Fi NSS offload enabled (persisted for next boot)"
			else
				log_action "Wi-Fi NSS offload disabled (persisted for next boot)"
			fi
		fi
	else
		log_note "Cannot persist ath11k nss_offload: $ATH11K_MODFILE is not writable."
	fi

	# Only a reboot (or a full ath11k reload) applies the change to the running
	# driver; if the live value still differs, tell the backend.
	rt=$(ath11k_runtime_value)
	if [ -n "$rt" ] && [ "$rt" != "$want" ]; then
		log_reboot "Wi-Fi NSS offload is still '$rt' in the running driver; a reboot is required to change it."
	fi
}

apply_mode() {
	local mode="$1"

	case "$mode" in
		statistics)
			set_flowtable 0
			ecm_present && set_ecm 0
			set_ath11k 0
			;;
		accelerate|*)
			if fullcone_enabled; then
				# Keep flowtable explicitly off so this page stays authoritative
				# even if flowtable was enabled elsewhere while FullCone is on.
				set_flowtable 0
				log_note "FullCone NAT is enabled: flowtable offload left off to keep inbound FullCone mapping consistent."
			else
				set_flowtable 1
			fi
			ecm_present && set_ecm 1
			set_ath11k 1
			;;
	esac
}

main() {
	local mode
	flowtable_changed=0
	mode=$(uci_get "$CONFIG.config.mode")
	[ -n "$mode" ] || mode=accelerate
	apply_mode "$mode"

	if [ "$flowtable_changed" = 1 ]; then
		/etc/init.d/firewall reload >/dev/null 2>&1
	fi

	exit 0
}

main "$@"
