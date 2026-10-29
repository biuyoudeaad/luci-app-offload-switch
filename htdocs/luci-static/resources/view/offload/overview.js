'use strict';
'require view';
'require dom';
'require rpc';
'require uci';
'require ui';

/*
 * luci-app-offload-switch
 *
 * One page that switches every traffic accelerator on or off, to trade
 * accurate per-host accounting against maximum throughput, and that shows
 * the auto-detected platform and its acceleration engines.
 *
 * The chosen goal is staged as an ordinary UCI change to `offload.config.mode`,
 * so the standard page action footer (Save & Apply / Apply unchecked / Save /
 * Reset) drives it like any other LuCI page. Committing the change runs the
 * reconciler through the ucitrack config trigger.
 */

var callStatus = rpc.declare({
	object: 'luci.offload',
	method: 'status',
	expect: { '': {} },
	reject: true
});

var CSS =
	'.ofs-card{background:var(--background-color-medium,#f6f6f6);border:1px solid var(--border-color-medium,#ddd);border-radius:6px;padding:1em;}' +
	'.ofs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(15em,1fr));gap:.6em 1.5em;}' +
	'.ofs-kv{display:flex;flex-direction:column;gap:.1em;}' +
	'.ofs-kv .k{font-size:85%;opacity:.7;}' +
	'.ofs-kv .v{font-weight:bold;word-break:break-word;}' +
	'.ofs-badge{display:inline-block;margin-left:.5em;padding:.1em .55em;border-radius:.75em;font-size:80%;font-weight:bold;vertical-align:middle;}' +
	'.ofs-badge.ok{background:#2e7d32;color:#fff;}' +
	'.ofs-badge.warn{background:#f9a825;color:#111;}' +
	'.ofs-badge.off{background:#78909c;color:#fff;}' +
	'.ofs-badge.lock{background:#5c6bc0;color:#fff;}' +
	'.ofs-badge.pending{background:#ef6c00;color:#fff;}' +
	'.ofs-engine{display:grid;grid-template-columns:1fr auto;gap:.15em .8em;align-items:center;padding:.6em .8em;border:1px solid var(--border-color-medium,#ddd);border-radius:5px;margin:.4em 0;background:var(--background-color-high,#fff);}' +
	'.ofs-engine .name{font-weight:bold;}' +
	'.ofs-engine .desc{grid-column:1/-1;font-size:88%;opacity:.8;}' +
	'.ofs-modes{display:grid;grid-template-columns:repeat(auto-fit,minmax(17em,1fr));gap:.8em;margin:.4em 0;}' +
	'.ofs-mode{position:relative;border:2px solid var(--border-color-medium,#ddd);border-radius:6px;padding:1em;cursor:pointer;transition:border-color .15s,box-shadow .15s;background:var(--background-color-high,#fff);}' +
	'.ofs-mode:hover{box-shadow:0 0 0 2px rgba(33,150,243,.15);}' +
	'.ofs-mode.selected{border-color:#2196f3;box-shadow:0 0 0 2px rgba(33,150,243,.25);}' +
	'.ofs-mode h4{margin:.1em 0 .3em;display:flex;align-items:center;gap:.5em;}' +
	'.ofs-mode input{margin:0;}' +
	'.ofs-mode .tagline{font-size:90%;opacity:.85;margin-bottom:.5em;}' +
	'.ofs-mode ul{margin:.3em 0 0;padding-left:1.1em;font-size:88%;}' +
	'.ofs-mode li{margin:.15em 0;}' +
	'.ofs-explain{margin-top:.7em;border-radius:6px;}' +
	'.ofs-explain h4{margin:.1em 0 .4em;}' +
	'.ofs-explain ul{margin:.3em 0 .2em;padding-left:1.2em;}' +
	'.ofs-explain li{margin:.2em 0;}' +
	'.ofs-help{font-size:88%;opacity:.8;margin:.3em 0 0;}';

function badge(text, kind) {
	return E('span', { 'class': 'ofs-badge ' + (kind || 'off') }, text);
}

function kv(label, value) {
	return E('div', { 'class': 'ofs-kv' }, [
		E('span', { 'class': 'k' }, label),
		E('span', { 'class': 'v' }, value)
	]);
}

function engineCard(e) {
	var state = e.active
		? badge(_('Active'), e.hardware ? 'warn' : 'ok')
		: badge(_('Off'), 'off');

	var ctrl;
	if (!e.controllable)
		ctrl = badge(_('Read-only'), 'off');
	else if (e.locked)
		ctrl = badge(_('Locked by FullCone'), 'lock');
	else
		ctrl = badge(_('Controllable'), 'ok');

	var type = e.hardware ? _('Hardware') : _('Software');

	var extra = e.pending_reboot === true ? [ ' ', badge(_('Reboot pending'), 'pending') ] : '';

	return E('div', { 'class': 'ofs-engine' }, [
		E('span', { 'class': 'name' }, e.label),
		E('span', {}, [ state, ' ', ctrl, extra ]),
		E('span', { 'class': 'desc' }, [ type, (e.note ? ' — ' + e.note : '') ])
	]);
}

return view.extend({
	load: function() {
		return Promise.all([
			callStatus().then(
				function(status) { return { status: status }; },
				function(error) { return { status: {}, error: error }; }
			),
			uci.load('offload')
		]);
	},

	render: function(data) {
		var statusResult = data[0] || {};
		var st = statusResult.status || {};
		var self = this;
		var detect = st.detect || {};
		var engines = st.engines || [];
		var fullcone = st.fullcone === true;
		var fullcone_build = st.fullcone_build === true;
		var has_nss = engines.some(function(e) { return e.id === 'nss-ecm'; });
		var has_wifi_nss = engines.some(function(e) { return e.id === 'nss-wifi'; });
		var wifi_nss_active = engines.some(function(e) { return e.id === 'nss-wifi' && e.active === true; });
		var statusError = statusResult.error;

		var applied = st.mode || uci.get('offload', 'config', 'mode') || 'accelerate';
		var selected = uci.get('offload', 'config', 'mode') || applied;

		dom.append(document.head, E('style', {}, CSS));

		/* ============================ header ============================ */
		var header = E('div', {}, [
			E('h2', {}, _('Traffic Offload Switch')),
			E('p', { 'class': 'ofs-help' },
				_('Switch every traffic accelerator on or off in one place: choose accurate per-host statistics or maximum routing throughput. The platform and its accelerators are detected automatically.'))
		]);

		var statusAlert = statusError ? E('div', { 'class': 'alert-message warning' }, [
			E('strong', {}, _('Unable to read accelerator status.')),
			E('div', {}, statusError.message || _('The luci.offload status RPC failed. Check rpcd and the package installation.'))
		]) : null;
		if (statusAlert)
			header.appendChild(statusAlert);

		if (st.pending_reboot === true) {
			header.appendChild(E('div', { 'class': 'alert-message warning' }, [
				E('strong', {}, _('A reboot is required.')),
				E('div', {}, _('The Wi-Fi NSS offload setting changed but the running driver still uses the previous value. Reboot the device to apply it.'))
			]));
		}

		/* ====================== current-state banner ==================== */
		var stateBanner = E('div', { 'class': 'ofs-card', 'style': 'margin-bottom:1em;' });
		self.renderState = function() {
			var goal;
			if (selected !== applied)
				goal = [ selected === 'statistics' ? _('Statistics') : _('Performance'), ' ', badge(_('pending'), 'pending') ];
			else
				goal = applied === 'statistics'
					? [ _('Statistics'), ' ', badge(_('active'), 'ok') ]
					: [ _('Performance'), ' ', badge(_('active'), 'warn') ];

			dom.content(stateBanner, E('div', { 'class': 'ofs-grid' }, [
				kv(_('Current goal'), goal),
				kv(_('Platform'), st.platform || _('Unknown')),
				kv(_('Model'), detect.model || detect.board || '—'),
				kv(_('Target'), detect.target ? detect.target + (detect.arch ? ' / ' + detect.arch : '') : '—'),
				kv(_('FullCone NAT'), fullcone ? badge(_('Enabled'), 'warn') : badge(_('Disabled'), 'off'))
			]));
		};
		self.renderState();

		/* ========================= engines card ======================== */
		var engineBlock = E('div', { 'class': 'ofs-card', 'style': 'margin-bottom:1em;' }, [
			E('h3', { 'style': 'margin-top:0;' }, _('Detected acceleration engines')),
			E('p', { 'class': 'ofs-help' },
				_('Active engines forward established traffic outside the normal CPU path. That is what makes the router fast, and also what makes per-host accounting under-report.')),
			statusError
				? E('em', {}, _('Engine status is unavailable because the status RPC failed.'))
				: engines.length
					? engines.map(engineCard)
					: E('em', {}, _('No hardware accelerator was detected; only the software network path is used.'))
		]);

		/* ========================= mode selector ======================= */
		function refreshModes() {
			[ statsCard, perfCard ].forEach(function(card) {
				var val = card.getAttribute('data-mode');
				if (val === selected)
					card.classList.add('selected');
				else
					card.classList.remove('selected');
				card.querySelector('input').checked = (val === selected);
			});
			self.renderExplain();
			self.renderState();
		}

		function modeCard(value, title, tagline, points) {
			var card = E('div', { 'class': 'ofs-mode', 'data-mode': value }, [
				E('h4', {}, [
					E('input', { 'type': 'radio', 'name': 'ofs-mode', 'value': value, 'checked': selected === value }),
					title
				]),
				E('div', { 'class': 'tagline' }, tagline),
				E('ul', {}, points.map(function(p) { return E('li', {}, p); }))
			]);
			card.addEventListener('click', function(ev) {
				if (ev.target.tagName !== 'INPUT')
					card.querySelector('input').click();
			});
			card.querySelector('input').addEventListener('change', function() {
				selected = value;
				uci.set('offload', 'config', 'mode', value);
				refreshModes();
			});
			return card;
		}

		var statsCard = modeCard('statistics', _('Statistics mode'),
			_('Acceleration off — keep traffic on the CPU.'),
			[
				_('Flowtable, NSS/ECM and Wi-Fi NSS offload turned off'),
				_('Conntrack / nlbwmon see forwarded flows again'),
				_('Lower maximum throughput / higher CPU load')
			]);

		var perfCard = modeCard('accelerate', _('Performance mode'),
			_('Acceleration on — fastest routing.'),
			[
				_('Accelerators enabled where safe'),
				_('Maximum throughput, lowest CPU load'),
				_('Conntrack-based accounting may under-report')
			]);

		var modesBlock = E('div', { 'class': 'ofs-card', 'style': 'margin-bottom:1em;' }, [
			E('h3', { 'style': 'margin-top:0;' }, _('Choose a goal')),
			E('div', { 'class': 'ofs-modes' }, [ statsCard, perfCard ])
		]);

		/* ====================== dynamic explanation ==================== */
		var explainBox = E('div', { 'class': 'ofs-card ofs-explain' });
		self.renderExplain = function() {
			var body;

			if (selected === 'statistics') {
				body = [
					E('h4', {}, [ badge(_('Statistics'), 'ok'), ' ', _('What will happen') ]),
					E('ul', {}, [
						E('li', {}, _('Netfilter flowtable offload is turned off (software and hardware).')),
						has_nss
							? E('li', {}, _('The Qualcomm NSS/ECM engine is stopped; accelerated flows are flushed and the module unloaded.'))
							: '',
						has_wifi_nss
							? E('li', {}, _('Wi-Fi NSS offload (ath11k) is turned off. A reboot is needed for this to take effect.'))
							: '',
						E('li', {}, _('Forwarded traffic returns to the CPU path, so conntrack / nlbwmon see it again.'))
					]),
					E('p', { 'class': 'ofs-help' },
						_('Use this while you need trustworthy per-host numbers, then switch back. Expect lower peak throughput.'))
				];

				if (has_wifi_nss && wifi_nss_active) {
					body.push(E('div', { 'class': 'alert-message warning' }, [
						E('strong', {}, _('A reboot is required.')),
						E('div', {}, _('The Wi-Fi NSS offload setting is only read when the driver starts, so it stays active until you reboot.'))
					]));
				}
			}
			else {
				body = [
					E('h4', {}, [ badge(_('Performance'), 'warn'), ' ', _('What will happen') ]),
					E('ul', {}, [
						E('li', {}, fullcone
							? _('Flowtable offload is kept off because FullCone NAT is enabled (see note below).')
							: _('Flowtable offload is enabled (software + hardware).')),
						has_nss
							? E('li', {}, _('The Qualcomm NSS/ECM engine is started for hardware acceleration.'))
							: '',
						has_wifi_nss
							? E('li', {}, _('Wi-Fi NSS offload (ath11k) is turned on. A reboot is needed for this to take effect.'))
							: '',
						E('li', {}, _('Throughput rises and CPU load drops, but conntrack-based accounting (nlbwmon) may under-report.'))
					]),
					E('p', { 'class': 'ofs-help' },
						_('This is the normal operating mode for everyday use.'))
				];

				if (fullcone) {
					body.push(E('div', { 'class': 'alert-message warning' }, [
						E('strong', {}, _('FullCone NAT is enabled.')),
						E('div', {}, _('Flowtable offload can make inbound FullCone mapping inconsistent, so it stays disabled in this mode. Hardware acceleration (NSS/ECM) is unaffected. To also enable flowtable offload, disable FullCone NAT first.'))
					]));
				}

				if (fullcone_build) {
					body.push(E('div', { 'class': 'alert-message notice', 'style': 'margin-top:.6em;' }, [
						E('strong', {}, _('Note on the firewall page.')),
						E('div', {}, _('The firewall page forces flowtable offload off whenever its form is saved, which will undo this setting. Re-apply this page afterwards if that happens.'))
					]));
				}
			}

			body.push(E('p', { 'class': 'ofs-help' },
				_('Note: accounting differs by tool. conntrack-based tools (nlbwmon) miss hardware-accelerated flows; eBPF/tc tools (bandix) count at the interface and may still see them.')));

			dom.content(explainBox, body);
		};

		refreshModes();

		return E('div', {}, [
			header,
			stateBanner,
			engineBlock,
			modesBlock,
			explainBox
		]);
	},

	/* ============================ footer actions ====================== */

	/* Stage the selected goal into the UCI session without committing it.
	 * uci.save() reloads the affected configs, which refreshes the header
	 * "Unsaved Changes" indicator through the uci-loaded event. */
	stage: function() {
		return uci.save();
	},

	handleSave: function(ev) {
		return this.stage().then(function() {
			ui.addNotification(null, E('p', _('Changes have been saved. Use "Save & Apply" to activate them.')), 'info');
		}).catch(function(err) {
			ui.addNotification(null, E('p', _('Unable to save changes: %s').format(err.message || err)), 'error');
		});
	},

	handleSaveApply: function(ev, mode) {
		return this.stage().then(function() {
			ui.changes.apply(mode == '0');
		}).catch(function(err) {
			ui.addNotification(null, E('p', _('Unable to apply changes: %s').format(err.message || err)), 'error');
		});
	},

	handleReset: function(ev) {
		return ui.changes.revert();
	}
});
