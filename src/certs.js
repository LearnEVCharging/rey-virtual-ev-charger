/**
 * certs.js — real X.509 crypto for Rey's certificate-management demo.
 *
 * This is NOT a toy: node-forge generates a genuine RSA key pair and a real
 * PKCS#10 CSR on the charge-point side, the demo CSMS acts as a mini-CA and
 * signs it into a real X.509 certificate, and the charge point parses and
 * stores it. You can copy the CSR into `openssl req -text` or the signed cert
 * into `openssl x509 -text` and they verify.
 *
 * This backs the OCPP 2.0.1 certificate-management messages (SignCertificate,
 * CertificateSigned, InstallCertificate, GetInstalledCertificateIds,
 * DeleteCertificate). It is the cert lifecycle those messages carry — not the
 * ISO 15118 EV-side handshake, which a browser tool can't do.
 */
import forge from 'node-forge';

const { pki, md, asn1, random, util } = forge;

// Random positive serial number as a hex string (leading 0 keeps it positive).
function randomSerial() {
  return '00' + util.bytesToHex(random.getBytesSync(8));
}

function sha256Hex(bytes) {
  return md.sha256.create().update(bytes).digest().toHex();
}

// SHA-256 fingerprint of the cert DER, formatted AA:BB:CC… like openssl.
export function fingerprintSha256(cert) {
  const der = asn1.toDer(pki.certificateToAsn1(cert)).getBytes();
  return sha256Hex(der).toUpperCase().match(/.{2}/g).join(':');
}

/**
 * Charge-point side: generate a fresh RSA key pair and a PKCS#10 CSR.
 * Returns PEM strings. The private key never leaves the charge point.
 */
export function generateKeyAndCsr({ commonName = 'Rey-001', organization = 'Learn EV Charging', country = 'US' } = {}) {
  const keys = pki.rsa.generateKeyPair(2048);
  const csr = pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: organization },
    { name: 'countryName', value: country },
  ]);
  csr.sign(keys.privateKey, md.sha256.create());
  return {
    privateKeyPem: pki.privateKeyToPem(keys.privateKey),
    csrPem: pki.certificationRequestToPem(csr),
  };
}

/**
 * CSMS side: create a self-signed root CA (once, at startup) that will sign
 * charge-point CSRs.
 */
export function createCA({ commonName = 'Rey Demo Root CA', organization = 'Learn EV Charging' } = {}) {
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: organization },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);
  cert.sign(keys.privateKey, md.sha256.create());
  return { caCertPem: pki.certificateToPem(cert), caKeyPem: pki.privateKeyToPem(keys.privateKey) };
}

/**
 * CSMS side: sign a charge-point CSR into a real leaf certificate under the CA.
 * Returns the certificate chain PEM (leaf + CA), like CertificateSigned carries.
 */
export function signCsr(csrPem, caCertPem, caKeyPem, { days = 365 } = {}) {
  const csr = pki.certificationRequestFromPem(csrPem);
  if (!csr.verify()) throw new Error('CSR signature is invalid');

  const caCert = pki.certificateFromPem(caCertPem);
  const caKey = pki.privateKeyFromPem(caKeyPem);

  const cert = pki.createCertificate();
  cert.publicKey = csr.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + days);
  cert.setSubject(csr.subject.attributes);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true },
  ]);
  cert.sign(caKey, md.sha256.create());
  return pki.certificateToPem(cert) + caCertPem;
}

// Split a PEM bundle into individual certificate PEM blocks (leaf first).
export function splitPemChain(pem) {
  const matches = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  return matches || [];
}

/**
 * Charge-point side: parse a stored cert into human-readable fields for the UI.
 */
export function summarizeCert(certPem) {
  const cert = pki.certificateFromPem(certPem);
  const cn = (dn) => dn.getField('CN')?.value || '(no CN)';
  const org = (dn) => dn.getField('O')?.value || '';
  return {
    subject: cn(cert.subject),
    subjectOrg: org(cert.subject),
    issuer: cn(cert.issuer),
    serialNumber: cert.serialNumber,
    notBefore: cert.validity.notBefore.toISOString(),
    notAfter: cert.validity.notAfter.toISOString(),
    fingerprint: fingerprintSha256(cert),
    selfSigned: cn(cert.subject) === cn(cert.issuer),
  };
}

/**
 * Charge-point side: the OCPP CertificateHashData for GetInstalledCertificateIds.
 * issuerNameHash / issuerKeyHash are SHA-256 over the issuer DN and public key.
 */
export function certHashData(certPem, issuerCertPem) {
  const cert = pki.certificateFromPem(certPem);
  const issuer = issuerCertPem ? pki.certificateFromPem(issuerCertPem) : cert; // self-signed → itself
  const issuerNameDer = asn1.toDer(pki.distinguishedNameToAsn1(cert.issuer)).getBytes();
  const issuerKeyDer = asn1.toDer(pki.publicKeyToAsn1(issuer.publicKey)).getBytes();
  return {
    hashAlgorithm: 'SHA256',
    issuerNameHash: sha256Hex(issuerNameDer),
    issuerKeyHash: sha256Hex(issuerKeyDer),
    serialNumber: cert.serialNumber,
  };
}
