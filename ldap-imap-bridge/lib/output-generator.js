const baseDnData = {
  dn: 'baseDn',
  attributes: {
    objectClass: ['top', 'organization', 'dcObject'],
    dc: ['organization'],
    o: ['domain']
  }
}

const peopleDnData = {
  dn: 'userDn',
  attributes: {
    objectClass: ['top', 'organizationalUnit'],
    ou: ['people']
  }
}

const groupDnData = {
  dn: 'groupDn',
  attributes: {
    objectClass: ['top', 'organizationalUnit'],
    ou: ['groups']
  }
}

var verboseOutput = false;

function init(nconf, verbose) {
  verboseOutput = verbose;
  baseDnData.dn = nconf.get('baseDn');
  baseDnData.attributes.dc = [nconf.get('organization')];
  baseDnData.attributes.o = [nconf.get('domain')];
  peopleDnData.dn = nconf.get('userDn');
  groupDnData.dn = nconf.get('groupDn');
}

function sendUser(req, res) {
  for (const k of Object.keys(req.customData.users)) {
    if (req.dn.equals(req.customData.users[k].dn)) {
      if (verboseOutput) console.debug('Send user: ', req.customData.users[k]);
      res.send(removeCacheAttribute(req.customData.users[k]));
    }
  }
}

function sendGroup(req, res) {
  for (const k of Object.keys(req.customData.groups)) {
    if (req.dn.equals(req.customData.groups[k].dn)) {
      if (verboseOutput) console.debug('Send group: ', req.customData.groups[k]);
      res.send(req.customData.groups[k]);
    }
  }
}

function sendUsers(req, res) {
  for (const k of Object.keys(req.customData.users)) {
    if (req.filter.matches(req.customData.users[k].attributes)) { 
      if (verboseOutput) console.debug('Send user: ', req.customData.users[k]);
      res.send(removeCacheAttribute(req.customData.users[k])); 
    }
  }
}

function sendGroups(req, res) {
  for (const k of Object.keys(req.customData.groups)) {
    if (req.filter.matches(req.customData.groups[k].attributes)) {
      if (verboseOutput) console.debug('Send group: ', req.customData.groups[k]);
      res.send(req.customData.groups[k]);
    }
  }
}

function sendGroupBase(req, res) {
  if (req.filter.matches(groupDnData.attributes)) {
    if (verboseOutput) console.debug('Send group base: ', groupDnData);
    res.send(groupDnData);
  }
}

function sendUsersBase(req, res) {
  if (req.filter.matches(peopleDnData.attributes)) {
    if (verboseOutput) console.debug('Send user base: ', peopleDnData);
    res.send(peopleDnData);
  }
}

function sendBase(req, res) {
  if (req.filter.matches(baseDnData.attributes)) { 
    if (verboseOutput) console.debug('Send base: ', baseDnData);
    res.send(baseDnData); 
  }
}

function removeCacheAttribute(user) {
  var userCache = JSON.parse(JSON.stringify(user));
  if (userCache.attributes.lastPasswordUpdate) {
    delete userCache.attributes.lastPasswordUpdate;
  }
  return userCache;
}

exports.init = init;
exports.removeCacheAttribute = removeCacheAttribute;
exports.sendBase = sendBase;
exports.sendUsersBase = sendUsersBase;
exports.sendGroupBase = sendGroupBase;
exports.sendGroups = sendGroups;
exports.sendUsers = sendUsers;
exports.sendUser = sendUser;
exports.sendGroup = sendGroup;