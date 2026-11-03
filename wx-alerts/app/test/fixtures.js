'use strict';
// NWS api.weather.gov alert features in the shape the API returns them (trimmed).
const base = (over) => ({
  id: 'urn:oid:2.49.0.1.840.0.' + Math.random().toString(16).slice(2),
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [[[-94.9, 39.1], [-94.4, 39.1], [-94.4, 39.4], [-94.9, 39.4], [-94.9, 39.1]]] },
  properties: {
    areaDesc: 'Platte, MO; Clay, MO; Wyandotte, KS',
    sent: '2026-11-01T22:41:00-06:00', effective: '2026-11-01T22:41:00-06:00', onset: '2026-11-01T22:41:00-06:00',
    expires: '2026-11-01T23:35:00-06:00', ends: '2026-11-01T23:35:00-06:00',
    status: 'Actual', messageType: 'Alert', category: 'Met', severity: 'Extreme', certainty: 'Observed', urgency: 'Immediate',
    event: 'Tornado Warning', senderName: 'NWS Kansas City/Pleasant Hill MO',
    headline: 'Tornado Warning issued November 1 at 10:41PM CDT until November 1 at 11:35PM CDT by NWS Kansas City/Pleasant Hill MO',
    description: 'The National Weather Service in Kansas City has issued a\n\n* Tornado Warning for...\nPlatte County in northwestern Missouri...\n\n* Until 1135 PM CDT.\n\n* At 1041 PM CDT, a severe thunderstorm capable of producing a tornado\nwas located near Parkville, moving northeast at 35 mph.\n\nHAZARD...Tornado and golf ball size hail.\n\nSOURCE...Radar indicated rotation.\n\nIMPACT...Flying debris will be dangerous to those caught without\nshelter. Mobile homes will be damaged or destroyed.\n\n* Locations impacted include...\nParkville, Platte City and Weatherby Lake.',
    instruction: 'TAKE COVER NOW! Move to a basement or an interior room on the lowest\nfloor of a sturdy building.',
    references: [],
    parameters: {
      VTEC: ['/O.NEW.KEAX.TO.W.0042.261102T0341Z-261102T0435Z/'],
      maxHailSize: ['1.75'], maxWindGust: ['70 MPH'], tornadoDetection: ['RADAR INDICATED'],
      eventMotionDescription: ['2026-11-02T03:41:00-00:00...storm...050DEG...30KT...39.19,-94.73'],
      NWSheadline: [],
    },
    ...over,
  },
});

const tornadoRadar = () => base({});
const tornadoObserved = () => base({ parameters: { ...base({}).properties.parameters, tornadoDetection: ['OBSERVED'] } });
const tornadoPds = () => base({ parameters: { ...base({}).properties.parameters, tornadoDetection: ['OBSERVED'], tornadoDamageThreat: ['CONSIDERABLE'], maxHailSize: ['2.00'], maxWindGust: ['75 MPH'] },
  description: base({}).properties.description + '\n\nTHIS IS A PARTICULARLY DANGEROUS SITUATION. TAKE COVER NOW!' });
const tornadoEmergency = () => base({ parameters: { ...base({}).properties.parameters, tornadoDetection: ['OBSERVED'], tornadoDamageThreat: ['CATASTROPHIC'], maxHailSize: ['2.75'], maxWindGust: ['80 MPH'] },
  headline: 'TORNADO EMERGENCY for Parkville and Platte City until 11:35PM CDT' });
const tornadoUpdate = (orig) => base({ messageType: 'Update', references: [{ '@id': orig.id, identifier: orig.id, sender: 'w-nws.webmaster@noaa.gov', sent: orig.properties.sent }],
  parameters: { ...orig.properties.parameters, VTEC: ['/O.CON.KEAX.TO.W.0042.000000T0000Z-261102T0435Z/'] } });
const severeTstm = () => base({ event: 'Severe Thunderstorm Warning', severity: 'Severe', certainty: 'Likely',
  headline: 'Severe Thunderstorm Warning issued November 1 at 10:41PM CDT until November 1 at 11:30PM CDT by NWS Kansas City/Pleasant Hill MO',
  description: 'HAZARD...60 mph wind gusts and quarter size hail.\n\nSOURCE...Radar indicated.\n\nIMPACT...Hail damage to vehicles is expected.',
  parameters: { VTEC: ['/O.NEW.KEAX.SV.W.0188.261102T0341Z-261102T0430Z/'], maxHailSize: ['1.00'], maxWindGust: ['60 MPH'], thunderstormDamageThreat: [] } });
const severeDestructive = () => base({ event: 'Severe Thunderstorm Warning', severity: 'Severe', certainty: 'Likely', description: 'HAZARD...80 mph wind gusts and baseball size hail.',
  parameters: { VTEC: ['/O.NEW.KEAX.SV.W.0189.261102T0341Z-261102T0430Z/'], maxHailSize: ['2.75'], maxWindGust: ['80 MPH'], thunderstormDamageThreat: ['DESTRUCTIVE'] } });
const tornadoWatch = () => base({ event: 'Tornado Watch', severity: 'Severe', certainty: 'Possible', urgency: 'Future', geometry: null,
  ends: '2026-11-02T04:00:00-06:00', expires: '2026-11-02T04:00:00-06:00',
  headline: 'Tornado Watch issued November 1 at 9:05PM CDT until November 2 at 4:00AM CDT by NWS Kansas City/Pleasant Hill MO',
  description: 'TORNADO WATCH 612 IS IN EFFECT UNTIL 400 AM CDT FOR THE FOLLOWING AREAS...',
  parameters: { VTEC: ['/O.NEW.KEAX.TO.A.0612.261102T0205Z-261102T0900Z/'], NWSheadline: ['TORNADO WATCH 612 REMAINS VALID UNTIL 4 AM CDT EARLY THIS MORNING'] } });
const tornadoWatchPds = () => { const f = tornadoWatch(); f.properties.description = 'THIS IS A PARTICULARLY DANGEROUS SITUATION.\n' + f.properties.description; return f; };
const windAdvisory = () => base({ event: 'Wind Advisory', severity: 'Moderate', certainty: 'Likely', urgency: 'Expected',
  ends: '2026-11-02T18:00:00-06:00', expires: '2026-11-02T18:00:00-06:00', headline: 'Wind Advisory issued ...',
  description: '* WHAT...Southwest winds 25 to 35 mph with gusts up to 50 mph.\n\n* WHERE...Portions of northwest Missouri.',
  parameters: { VTEC: ['/O.NEW.KEAX.WI.Y.0031.261102T1200Z-261103T0000Z/'], NWSheadline: ['WIND ADVISORY IN EFFECT UNTIL 6 PM CST MONDAY'] } });

module.exports = { tornadoRadar, tornadoObserved, tornadoPds, tornadoEmergency, tornadoUpdate, severeTstm, severeDestructive, tornadoWatch, tornadoWatchPds, windAdvisory };
