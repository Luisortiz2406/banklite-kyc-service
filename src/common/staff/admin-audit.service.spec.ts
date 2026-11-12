import { AdminAuditService } from './admin-audit.service';

describe('AdminAuditService', () => {
  const staff = { id: 's1', username: 'laura', role: 'compliance' } as never;
  const repo = {
    create: jest.fn((row: any) => row),
    save: jest.fn(),
    findAndCount: jest.fn().mockResolvedValue([[{ id: 1 }], 1]),
  };
  const service = new AdminAuditService(repo as never);

  beforeEach(() => jest.clearAllMocks());

  it('registra quién hizo qué, con el motivo recortado a 300 caracteres', async () => {
    await service.record(staff, {
      action: 'kyc.approve',
      targetType: 'kyc',
      targetId: 'u1',
      reason: `  ${'m'.repeat(400)}`,
      details: { a: 1 },
    });

    const row = repo.create.mock.calls[0][0];
    expect(row).toMatchObject({
      staffId: 's1',
      staffUsername: 'laura',
      staffRole: 'compliance',
      action: 'kyc.approve',
      targetId: 'u1',
      details: { a: 1 },
    });
    expect(row.reason).toHaveLength(300);
    expect(repo.save).toHaveBeenCalled();
  });

  it('sin motivo ni detalles guarda null, y con la transacción del llamador usa su repositorio', async () => {
    const txRepo = { create: jest.fn((row: any) => row), save: jest.fn() };
    const manager = { getRepository: jest.fn(() => txRepo) };

    await service.record(staff, { action: 'a', targetType: 't', targetId: 'x', reason: '   ' }, manager as never);

    expect(txRepo.create.mock.calls[0][0]).toMatchObject({ reason: null, details: null });
    expect(txRepo.save).toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('el listado tiene tope de 200 por página y filtra por objetivo', async () => {
    expect(await service.list(3, 500, 'u1')).toEqual({ items: [{ id: 1 }], total: 1, page: 3, limit: 200 });
    expect(repo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { targetId: 'u1' }, skip: 400, take: 200 }),
    );

    await service.list(0, 0);
    expect(repo.findAndCount).toHaveBeenLastCalledWith(expect.objectContaining({ where: {}, skip: 0, take: 1 }));
  });
});
