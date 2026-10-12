import { registerInvoiceTools } from '../../src/tools/invoices';
import { InvoicesClient } from '../../src/client/invoices-client';
import { createServer } from 'node:http';

const payment = { id: 91, amount: 25, paid_date: '2026-10-10' };

function tool(name: string, client: any) {
  const registration = registerInvoiceTools({ harvestClient: client, logger: {} }).find(x => x.tool.name === name);
  if (!registration) throw new Error(`Missing ${name}`);
  return registration;
}

function body(result: any) {
  return JSON.parse(result.content[0].text);
}

describe('invoice payment tools', () => {
  it('lists payments and preserves Harvest pagination links', async () => {
    const data = { invoice_payments: [payment], links: { next: 'https://api.harvestapp.com/v2/invoices/7/payments?cursor=abc' } };
    const getInvoicePayments = jest.fn().mockResolvedValue(data);
    const registration = tool('list_invoice_payments', { getInvoicePayments });
    const result = await registration.handler.execute({ invoice_id: 7, per_page: 1 });
    expect(body(result)).toEqual(data);
    expect(getInvoicePayments).toHaveBeenCalledWith(7, { per_page: 1 });
    expect(registration.tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true });
  });

  it('records a partial payment and reports the refreshed balance', async () => {
    const createInvoicePayment = jest.fn().mockResolvedValue(payment);
    const getInvoice = jest.fn().mockResolvedValue({ id: 7, due_amount: 75, state: 'open' });
    const registration = tool('record_invoice_payment', { createInvoicePayment, getInvoice });
    const result = await registration.handler.execute({ invoice_id: 7, amount: 25, paid_date: '2026-10-10' });
    expect(body(result)).toMatchObject({ payment, invoice: { id: 7, due_amount: 75, state: 'open' }, status: 'recorded' });
    expect(createInvoicePayment).toHaveBeenCalledWith(7, { amount: 25, paid_date: '2026-10-10', send_thank_you: false });
    expect(getInvoice).toHaveBeenCalledWith(7);
    expect(registration.tool.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true });
  });

  it('reports a fully paid refreshed invoice', async () => {
    const createInvoicePayment = jest.fn().mockResolvedValue(payment);
    const result = await tool('record_invoice_payment', {
      createInvoicePayment,
      getInvoice: jest.fn().mockResolvedValue({ id: 7, due_amount: 0, state: 'paid' }),
    }).handler.execute({ invoice_id: 7, amount: 25, paid_at: '2026-10-10T12:00:00Z', send_thank_you: true, notes: 'ACH' });
    expect(body(result).invoice).toMatchObject({ due_amount: 0, state: 'paid' });
    expect(createInvoicePayment).toHaveBeenCalledWith(7, { amount: 25, paid_at: '2026-10-10T12:00:00Z', send_thank_you: true, notes: 'ACH' });
  });

  it('rejects invalid input before POST', async () => {
    const createInvoicePayment = jest.fn();
    const registration = tool('record_invoice_payment', { createInvoicePayment });
    const invalid = [
      { invoice_id: 0, amount: 1, paid_date: '2026-10-10' },
      { invoice_id: 7, amount: 0, paid_date: '2026-10-10' },
      { invoice_id: 7, amount: Infinity, paid_date: '2026-10-10' },
      { invoice_id: 7, amount: 1 },
      { invoice_id: 7, amount: 1, paid_date: '2026-02-30' },
      { invoice_id: 7, amount: 1, paid_at: 'yesterday' },
      { invoice_id: 7, amount: 1, paid_at: '2026-10-10T12:00:00Z', paid_date: '2026-10-10' },
    ];
    for (const args of invalid) expect((await registration.handler.execute(args)).isError).toBe(true);
    expect(createInvoicePayment).not.toHaveBeenCalled();
  });

  it('preserves success when followup invoice read fails', async () => {
    const createInvoicePayment = jest.fn().mockResolvedValue(payment);
    const result = await tool('record_invoice_payment', {
      createInvoicePayment,
      getInvoice: jest.fn().mockRejectedValue(new Error('read timed out')),
    }).handler.execute({ invoice_id: 7, amount: 25, paid_date: '2026-10-10' });
    expect(result.isError).not.toBe(true);
    expect(body(result)).toMatchObject({ status: 'recorded_verification_failed', payment });
    expect(body(result).message).toMatch(/do not retry/i);
    expect(createInvoicePayment).toHaveBeenCalledTimes(1);
  });

  it('does not retry an uncertain POST failure and tells caller to reconcile', async () => {
    const createInvoicePayment = jest.fn().mockRejectedValue(new Error('network timeout'));
    const result = await tool('record_invoice_payment', { createInvoicePayment }).handler.execute({ invoice_id: 7, amount: 25, paid_date: '2026-10-10' });
    expect(createInvoicePayment).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toMatch(/check.*payment.*before retry/i);
  });
});

describe('invoice payments HTTP boundary', () => {
  it('uses the exact payment path and forwards the response', async () => {
    const get = jest.fn().mockResolvedValue({ data: { invoice_payments: [payment], links: { next: null } } });
    const post = jest.fn().mockResolvedValue({ data: payment });
    const client: any = new InvoicesClient({ accessToken: 'fixture', accountId: '1', httpClient: { get, post } });
    expect(await client.getInvoicePayments(7, { per_page: 1 })).toMatchObject({ invoice_payments: [payment] });
    expect(get).toHaveBeenCalledWith('/invoices/7/payments?per_page=1', { maxRedirects: 0 });
    expect(await client.createInvoicePayment(7, { amount: 25, paid_date: '2026-10-10', send_thank_you: false })).toEqual(payment);
    expect(post).toHaveBeenCalledWith('/invoices/7/payments', { amount: 25, paid_date: '2026-10-10', send_thank_you: false }, { maxRedirects: 0 });
  });

  it('follows a validated cursor URL without constructing a page number', async () => {
    const get = jest.fn().mockResolvedValue({ data: { invoice_payments: [] } });
    const client: any = new InvoicesClient({ accessToken: 'fixture', accountId: '1', httpClient: { get } });
    await client.getInvoicePayments(7, { page_url: 'https://api.harvestapp.com/v2/invoices/7/payments?cursor=abc&per_page=1&ref=next_cursor' });
    expect(get).toHaveBeenCalledWith('/invoices/7/payments?cursor=abc&per_page=1&ref=next_cursor', { maxRedirects: 0 });
    await expect(client.getInvoicePayments(7, { page_url: 'https://evil.example/v2/invoices/7/payments?cursor=abc' })).rejects.toThrow();
    await expect(client.getInvoicePayments(7, { page_url: 'https://api.harvestapp.com/v2/invoices/8/payments?cursor=abc' })).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not retry a rejected payment HTTP request', async () => {
    const post = jest.fn().mockRejectedValue(new Error('connection lost'));
    const client = new InvoicesClient({ accessToken: 'fixture', accountId: '1', httpClient: { post } });
    await expect(client.createInvoicePayment(7, { amount: 25, paid_date: '2026-10-10', send_thank_you: false })).rejects.toThrow('connection lost');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([500, 429, 'disconnect'] as const)('never retries a real Axios payment POST after %s', async failure => {
    let attempts = 0;
    const server = createServer((request, response) => {
      attempts++;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/invoices/7/payments');
      if (failure === 'disconnect') {
        request.socket.destroy();
      } else {
        response.writeHead(failure, { 'Content-Type': 'application/json' });
        response.end('{}');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No local port');
      const client = new InvoicesClient({
        accessToken: 'fixture', accountId: '1', baseUrl: `http://127.0.0.1:${address.port}`,
        timeout: 1000,
      });
      await expect(client.createInvoicePayment(7, { amount: 25, paid_date: '2026-10-10', send_thank_you: false })).rejects.toThrow();
      expect(attempts).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each([
    ['GET', 302],
    ['POST', 307],
    ['POST', 308],
  ] as const)('does not follow a %s payment redirect with status %s', async (method, status) => {
    let attempts = 0;
    const server = createServer((request, response) => {
      attempts++;
      if (attempts === 1) {
        expect(request.method).toBe(method);
        expect(request.url).toBe('/invoices/7/payments');
        response.writeHead(status, { Location: '/other', 'Content-Type': 'application/json' });
        response.end('{}');
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No local port');
      const client = new InvoicesClient({
        accessToken: 'fixture', accountId: '1', baseUrl: `http://127.0.0.1:${address.port}`,
      });
      const operation = method === 'GET'
        ? client.getInvoicePayments(7)
        : client.createInvoicePayment(7, { amount: 25, paid_date: '2026-10-10', send_thank_you: false });
      await expect(operation).rejects.toThrow();
      expect(attempts).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
