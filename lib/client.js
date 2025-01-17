const io           = require('socket.io-client');
const https        = require('https');
const util         = require('util');
const EventEmitter = require('events').EventEmitter;
const moment       = require('moment-timezone');

function NightscoutClient(adapter, URL, secretHash) {
    if (adapter.config.secure) {
        https.globalAgent.options.rejectUnauthorized = false;
    }

    this.URL = URL || `http${adapter.config.secure ? 's' : ''}://${adapter.config.bind}:${adapter.config.port}`;
    this.previousNotifyTimestamp = null;

    if (!secretHash && adapter.config.remoteSecret) {
        const shaSum = require('crypto').createHash('sha1');
        shaSum.update(adapter.config.remoteSecret);
        secretHash = shaSum.digest('hex');
    } else {
        secretHash = secretHash || null;
    }

    this.secretHash = secretHash;

    this.nsSocket = io(this.URL, {
        path: '/socket.io',
        agent: adapter.config.secure ? https.globalAgent : undefined
    });

    this.nsSocket.on('disconnect', () => {
        this.emit('connection', false);
        adapter.log.debug('[CLIENT] own client disconnected');
    });

    this.nsSocket.on('connect', () => {
        this.previousNotifyTimestamp = null;

        adapter.log.debug('[CLIENT] own client connected');
        this.emit('connection', true);
        this.nsSocket.emit('authorize', {
            client: 'iobroker',
            secret: this.secretHash,
            history: 48,
        },
        data => {
            if (!data.read) {
                adapter.log.error('Cannot authenticate: ' + JSON.stringify(data));
            }
        });
    });

    this.previousNotifyTimestamp = null;

    this.nsSocket.on('notification', data => {
        adapter.log.debug('[CLIENT] notification: ' + JSON.stringify(data));
        if (data) {
            if (data.timestamp && data.timestamp === this.previousNotifyTimestamp) {
                // ignore
                return;
            }
            if (data.timestamp) {
                this.previousNotifyTimestamp = data.timestamp;
            }
            const ts = new Date(data.timestamp || undefined).getTime();
            adapter.setState('data.notification', {ts: ts || Date.now(), ack: true, val: `${data.title} ${data.message}`});
        }
    });

    this.nsSocket.on('announcement', data =>
        adapter.log.debug('[CLIENT] announcement: ' + data));

    this.nsSocket.on('alarm', data => {
        adapter.log.debug('[CLIENT] alarm: ' + JSON.stringify(data));
        adapter.setState('data.alarm', data && data.level && data.level === 1, true);
    });

    this.nsSocket.on('urgent_alarm', data => {
        adapter.log.debug('[CLIENT] urgentAlarm: ' + JSON.stringify(data));
        adapter.setState('data.urgentAlarm', data && data.level && data.level === 2, true);
    });

    this.nsSocket.on('clear_alarm', data => {
        adapter.log.debug('[CLIENT] clear_alarm: ' + JSON.stringify(data));
        if (data.clear) {
            adapter.setState('data.alarm', false, true);
            adapter.setState('data.urgentAlarm', false, true);
        }
    });

    this.nsSocket.on('dataUpdate', dataUpdate => {
        adapter.log.debug('[CLIENT] dataUpdate: ' + JSON.stringify(dataUpdate));
        try {
            adapter.setState('data.rawUpdate', JSON.stringify(dataUpdate), true);
            if (dataUpdate) {
                const now = Date.now();
                const ts = dataUpdate.lastUpdated || now;
                if (dataUpdate.lastUpdated) {
                    adapter.setState('data.lastUpdate', dataUpdate.lastUpdated, true);
                }

                if (dataUpdate.devicestatus && dataUpdate.devicestatus.length) {
                    const status = dataUpdate.devicestatus.pop();
                    adapter.setState('data.device', status.device, true);

                    if (status.pump) {
                        adapter.setState('data.clock',       {ts, ack: true, val: new Date(status.pump.clock).getTime()});
                        adapter.setState('data.reservoir',   {ts, ack: true, val: status.pump.reservoir});

                        status.pump.iob     && adapter.setState('data.bolusiob',    {ts, ack: true, val: status.pump.iob.bolusiob});
                        status.pump.battery && adapter.setState('data.pumpBattery', {ts, ack: true, val: status.pump.battery.percent});

                        if (status.pump.status) {
                            adapter.setState('data.bolusing',    {ts, ack: true, val: status.pump.status.bolusing});
                            adapter.setState('data.status',      {ts, ack: true, val: status.pump.status.status});
                            adapter.setState('data.suspended',   {ts, ack: true, val: status.pump.status.suspended});
                        }
                    }

                    status.uploader && adapter.setState('data.uploaderBattery', status.uploader.battery, true);
                }

                if (dataUpdate.sgvs && dataUpdate.sgvs.length) {
                    const sgv = dataUpdate.sgvs.pop();
                    adapter.setState('data.mgdl',          {ts: sgv.mills, ack: true, val: sgv.mgdl});
                    adapter.setState('data.mgdlScaled',    {ts: sgv.mills, ack: true, val: sgv.scaled});
                    adapter.setState('data.mgdlDirection', {ts: sgv.mills, ack: true, val: sgv.direction});
                }

                let siteChangeUpdated = false;
                let sensorUpdated = false;
                if (dataUpdate.treatments && dataUpdate.treatments.length) {
                    const sitechangeTreatments = dataUpdate.treatments.filter(treatment =>
                        treatment.eventType && treatment.eventType.includes('Site Change'));

                    const cannulaInfo = this._getLatestTreatmentsInfo(sitechangeTreatments);
                    if (cannulaInfo.found) {
                        adapter.setState('data.cage.age', {ts: now, ack: true, val: cannulaInfo.age});
                        adapter.setState('data.cage.days', {ts: now, ack: true, val: cannulaInfo.days});
                        adapter.setState('data.cage.hours', {ts: now, ack: true, val: cannulaInfo.hours});
                        adapter.setState('data.cage.changed', {
                            ts: cannulaInfo.millis,
                            ack: true,
                            val: new Date(cannulaInfo.millis).getTime()
                        });
                        siteChangeUpdated = true;
                    }

                    const sensorTreatments = dataUpdate.treatments.filter(treatment =>
                        treatment.eventType && (
                            treatment.eventType.includes('Sensor Start') ||
                            treatment.eventType.includes('Sensor Change')
                        )
                    );
                    const sensorInfo = this._getLatestTreatmentsInfo(sensorTreatments);
                    if (sensorInfo.found) {
                        adapter.setState('data.sage.age', {ts: now, ack: true, val: sensorInfo.age});
                        adapter.setState('data.sage.days', {ts: now, ack: true, val: sensorInfo.days});
                        adapter.setState('data.sage.hours', {ts: now, ack: true, val: sensorInfo.hours});
                        adapter.setState('data.sage.changed', {
                            ts: sensorInfo.millis,
                            ack: true,
                            val: new Date(sensorInfo.millis).getTime()
                        });
                        sensorUpdated = true;
                    }
                }

                if (dataUpdate.food && dataUpdate.food.length) {
                    const sitechangeTreatments = dataUpdate.food.filter(treatment =>
                        treatment.eventType && treatment.eventType.includes('Site Change'));
                    // todo: process food
                }

                if (!siteChangeUpdated) {
                    adapter.log.debug('[CLIENT] No cannula treatments found. Recalculate age');
                    this._recalcAges('data.cage');
                }
                if (!sensorUpdated) {
                    adapter.log.debug('[CLIENT] No sensor treatments found. Recalculate age');
                    this._recalcAges('data.sage');
                }
            }
        } catch (error) {
            adapter.log.error('[CLIENT] Parse Error: ' + error);
        }
    });

    this.nsSocket.on('retroUpdate', function retroUpdate (retroData) {
        adapter.log.debug('[CLIENT] retroUpdate', retroData);
    });

    this.close = () => {
        if (this.nsSocket) {
            this.nsSocket.close();
            this.nsSocket = null;
        }
    };

    this._getLatestTreatmentsInfo = (treatments) => {
        const treatmentInfo = {
            found: false,
            age: 0,
            days: 0,
            hours: 0,
            millis: 0
        };
        if (treatments.length) {
            const now = Date.now(), a = moment(now);
            let prevDate = 0;

            treatments.forEach(treatment => {
                const treatmentDate = treatment.mills;

                if (treatmentDate > prevDate && treatmentDate <= now) {
                    prevDate = treatmentDate;

                    const b = moment(treatmentDate);
                    const days = a.diff(b, 'days');
                    const hours = a.diff(b, 'hours') - days * 24;
                    const age = a.diff(b, 'hours');

                    if (!treatmentInfo.found || (age >= 0 && age < treatmentInfo.age)) {
                        treatmentInfo.found = true;
                        treatmentInfo.age = age;
                        treatmentInfo.days = days;
                        treatmentInfo.hours = hours;
                        treatmentInfo.millis = treatmentDate;
                    }
                }
            });
        }

        return treatmentInfo;
    };

    this._recalcAges = baseId =>
        adapter.getStateAsync(baseId + '.changed')
            .then((state) => {
                if (state) {
                    const now = Date.now(), a = moment(now);
                    const treatmentDate = state.val;
                    const b = moment(treatmentDate);
                    const days = a.diff(b, 'days');
                    const hours = a.diff(b, 'hours') - days * 24;
                    const age = a.diff(b, 'hours');

                    adapter.setState(baseId + '.age', {ts: now, ack: true, val: age});
                    adapter.setState(baseId + '.days', {ts: now, ack: true, val: days});
                    adapter.setState(baseId + '.hours', {ts: now, ack: true, val: hours});
                }
            });
}

// extend the EventEmitter class using our class
util.inherits(NightscoutClient, EventEmitter);

module.exports = NightscoutClient;
