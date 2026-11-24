import { win32 } from 'node:path';

export const appContainerStoragePolicy = 'workspace-and-appcontainer-storage-v1';

export function safeProfileRelative(path) {
  return typeof path === 'string' && /^\\[^\\]/.test(path) &&
    !path.includes('/') && !path.includes(':') && !path.includes('\0') &&
    path.slice(1).split('\\').every(part => part && part !== '.' && part !== '..' && !/[ .]$/.test(part) && !/[\x00-\x1f<>"|?*]/.test(part));
}

export function profileStorageLocation(profileName, sid, localAppData = process.env.LOCALAPPDATA) {
  if (!/^BridgeV2\.[A-Za-z0-9.-]{1,54}$/.test(profileName ?? '') ||
    !/^S-1-15-2-(\d+-){6}\d+$/.test(sid ?? '') || !localAppData || !win32.isAbsolute(localAppData))
    throw Error('Invalid registered AppContainer storage identity');
  return { profileName, sid, packagePath: win32.join(localAppData, 'Packages', profileName),
    registryPath: 'HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings\\' + sid };
}

export function assessAllowedProfileStorage(before, after, identity) {
  const location = profileStorageLocation(identity.profileName, identity.sid, identity.localAppData);
  const assessment = assessProfileStorage(before, after);
  const valid = snapshot => snapshot?.mappingExists === true && snapshot.packageExists === true &&
    snapshot.moniker === location.profileName && snapshot.mappingMoniker?.toLowerCase() === location.profileName.toLowerCase() && snapshot.sid === location.sid &&
    snapshot.packagePath?.toLowerCase() === location.packagePath.toLowerCase() && snapshot.registryPath === location.registryPath &&
    snapshot.scanComplete === true && Array.isArray(snapshot.reparsePoints) && snapshot.reparsePoints.length === 0 &&
    Array.isArray(snapshot.files) && snapshot.files.every(file => safeProfileRelative(file.relative));
  const privateStorageAllowedVerified = valid(before) && valid(after);
  return { ...assessment, storagePolicy: appContainerStoragePolicy, privateStorage: location,
    privateStorageAllowedVerified, allowedProfileWrites: privateStorageAllowedVerified ? assessment.externalWrites : [],
    unexpectedExternalWrites: privateStorageAllowedVerified ? [] : assessment.externalWrites,
    registryScope: 'Registered profile mapping; registry values are not exhaustively traced' };
}

export function assessProfileStorage(before, after, { privateStorageWriteDenied = false } = {}) {
  const complete = Array.isArray(before?.files) && Array.isArray(after?.files);
  const previous = new Map((before?.files ?? []).map(file => [file.relative, file]));
  const current = new Map((after?.files ?? []).map(file => [file.relative, file]));
  const externalWrites = [];
  for (const [path, value] of current) {
    if (!previous.has(path)) externalWrites.push({ path, kind: 'added', after: value });
    else if (JSON.stringify(previous.get(path)) !== JSON.stringify(value)) externalWrites.push({ path, kind: 'changed', before: previous.get(path), after: value });
  }
  for (const [path, value] of previous) if (!current.has(path)) externalWrites.push({ path, kind: 'removed', before: value });
  const identityUnchanged = before?.sid === after?.sid && before?.moniker === after?.moniker &&
    before?.mappingExists === after?.mappingExists && before?.packageExists === after?.packageExists;
  return { completeProfileSnapshots: complete, profileUnchanged: complete && identityUnchanged && externalWrites.length === 0,
    privateStorageWriteDenied, privateStorageVerified: complete && identityUnchanged && !externalWrites.length && privateStorageWriteDenied === true,
    externalWrites };
}
