const KEY = 'a'.repeat(64);

const original = process.env.KYC_ENCRYPTION_KEY;
afterAll(() => {
  if (original === undefined) delete process.env.KYC_ENCRYPTION_KEY;
  else process.env.KYC_ENCRYPTION_KEY = original;
});

/** La llave se lee del entorno al usarla y se guarda por módulo: cada caso carga una copia limpia. */
function load(key: string | undefined) {
  if (key === undefined) delete process.env.KYC_ENCRYPTION_KEY;
  else process.env.KYC_ENCRYPTION_KEY = key;
  let mod!: typeof import('./field-crypto');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('./field-crypto');
  });
  return mod;
}

describe('cifrado de datos de identidad', () => {
  it('cifra con AES-GCM y descifra el mismo valor; cada cifrado es distinto (IV aleatorio)', () => {
    const { encryptField, decryptField, isEncrypted } = load(KEY);

    const a = encryptField('1000000001') as string;
    const b = encryptField('1000000001') as string;

    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toContain('1000000001');
    expect(isEncrypted(a)).toBe(true);
    expect(decryptField(a)).toBe('1000000001');
    expect(decryptField(b)).toBe('1000000001');
  });

  it('lo ya cifrado no se vuelve a cifrar y lo que no es texto pasa igual', () => {
    const { encryptField, decryptField, isEncrypted } = load(KEY);
    const cifrado = encryptField('dato') as string;

    expect(encryptField(cifrado)).toBe(cifrado);
    expect(encryptField(null)).toBeNull();
    expect(encryptField(42)).toBe(42);
    expect(isEncrypted(42)).toBe(false);
    // Datos anteriores al cifrado se devuelven tal cual
    expect(decryptField('texto plano')).toBe('texto plano');
    expect(decryptField(null)).toBeNull();
  });

  it('un texto cifrado alterado no se descifra (la etiqueta GCM lo detecta)', () => {
    const { encryptField, decryptField } = load(KEY);
    const cifrado = encryptField('dato') as string;
    const raw = Buffer.from(cifrado.slice(3), 'base64');
    raw[raw.length - 1] ^= 0xff;

    expect(() => decryptField('v1:' + raw.toString('base64'))).toThrow();
  });

  it('el índice ciego es estable, ignora mayúsculas y espacios, y cambia con el valor', () => {
    const { blindIndex } = load(KEY);

    expect(blindIndex(' ABC ')).toBe(blindIndex('abc'));
    expect(blindIndex('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(blindIndex('abc')).not.toBe(blindIndex('abd'));
    expect(blindIndex('abc')).not.toBe(load('b'.repeat(64)).blindIndex('abc'));
    expect(blindIndex('   ')).toBeNull();
    expect(blindIndex(null)).toBeNull();
    expect(blindIndex(undefined)).toBeNull();
  });

  it('falla cerrado: sin llave, o con una mal formada, no se cifra ni se indexa nada', () => {
    expect(() => load(undefined).encryptField('x')).toThrow('KYC_ENCRYPTION_KEY no está configurada');
    expect(() => load(undefined).blindIndex('x')).toThrow('KYC_ENCRYPTION_KEY no está configurada');
    expect(() => load('corta').encryptField('x')).toThrow('64 caracteres hexadecimales');
    expect(() => load('z'.repeat(64)).blindIndex('x')).toThrow('64 caracteres hexadecimales');
  });

  it('el transformer de la columna cifra al guardar y descifra al leer', () => {
    const { encryptedColumn } = load(KEY);
    const guardado = encryptedColumn.to('1990-01-01') as string;

    expect(guardado.startsWith('v1:')).toBe(true);
    expect(encryptedColumn.from(guardado)).toBe('1990-01-01');
  });
});
