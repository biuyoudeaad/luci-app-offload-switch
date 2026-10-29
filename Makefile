# Copyright (C) 2026
#
# This is free software, licensed under the Apache License, Version 2.0.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-offload-switch
PKG_VERSION:=20261027
PKG_RELEASE:=4
PKG_PO_VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=ImmortalWrt

LUCI_TITLE:=LuCI Traffic Offload Switch (statistics vs. performance)
LUCI_DESCRIPTION:=Switch all traffic accelerators (netfilter flowtable and vendor engines such as Qualcomm NSS/ECM and Wi-Fi NSS offload) on or off from one page, to trade accurate traffic accounting against maximum throughput. Auto-detects and displays the current platform and its acceleration engines.
LUCI_DEPENDS:=+luci-base +nftables-json +uci-firewall
LUCI_PKGARCH:=all

define Package/$(PKG_NAME)/conffiles
/etc/config/offload
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
