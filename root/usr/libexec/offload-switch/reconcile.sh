#!/bin/sh
#
# Single source of truth for luci-app-offload-switch.
#
# Reads the desired goal from /etc/config/offload (mode: statistics|accelerate)
# and maps it onto every traffic accelerator:
#   - netfilter flowtable      (firewall.@defaults[0].flow_offloading[_hw])
#   - Qualcomm NSS/ECM         (/etc/init.d/qca-nss-ecm start|stop)
#
# Emits machine-readable result lines for the RPC backend:
#   ACTION: <what changed>
#   NOTE:   <warning / caveat>
#
# Safe to run repeatedly and at boot: it only touches state that differs from
# the target, so it will not needlessly tear down live accelerated flows.

. /lib/functions.sh

CONFIG=offload
ECM_INIT=/etc/init.d/qca-nss-ecm

log_action() { echo "ACTION: $1"; }
log_note()   { echo "NOTE: $1"; }

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

	# Keep the boot-time rc.d state in sync so a reboot starts clean, and so
	# qca-nss-pbuf (START=27) does not silently re-arm the engine on boot.
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

apply_mode() {
	local mode="$1"

	case "$mode" in
		statistics)
			set_flowtable 0
			ecm_present && set_ecm 0
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
			;;
	esac
}

main() {
	local mode
	mode=$(uci_get "$CONFIG.config.mode")
	[ -n "$mode" ] || mode=accelerate
	apply_mode "$mode"
	exit 0
}

main "$@"
