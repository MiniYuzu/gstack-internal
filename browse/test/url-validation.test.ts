import { describe, it, expect } from 'bun:test';
import { validateNavigationUrl } from '../src/url-validation';

describe('validateNavigationUrl', () => {
  it('allows http URLs', async () => {
    await expect(validateNavigationUrl('http://example.com')).resolves.toBeUndefined();
  });

  it('allows https URLs', async () => {
    await expect(validateNavigationUrl('https://example.com/path?q=1')).resolves.toBeUndefined();
  });

  it('allows localhost', async () => {
    await expect(validateNavigationUrl('http://localhost:3000')).resolves.toBeUndefined();
  });

  it('allows 127.0.0.1', async () => {
    await expect(validateNavigationUrl('http://127.0.0.1:8080')).resolves.toBeUndefined();
  });

  it('allows private IPs', async () => {
    await expect(validateNavigationUrl('http://192.168.1.1')).resolves.toBeUndefined();
  });

  it('blocks file:// scheme', async () => {
    await expect(validateNavigationUrl('file:///etc/passwd')).rejects.toThrow(/scheme.*not allowed/i);
  });

  it('blocks javascript: scheme', async () => {
    await expect(validateNavigationUrl('javascript:alert(1)')).rejects.toThrow(/scheme.*not allowed/i);
  });

  it('blocks data: scheme', async () => {
    await expect(validateNavigationUrl('data:text/html,<h1>hi</h1>')).rejects.toThrow(/scheme.*not allowed/i);
  });

  it('blocks AWS/GCP metadata endpoint', async () => {
    await expect(validateNavigationUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks GCP metadata hostname', async () => {
    await expect(validateNavigationUrl('http://metadata.google.internal/computeMetadata/v1/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks Azure metadata hostname', async () => {
    await expect(validateNavigationUrl('http://metadata.azure.internal/metadata/instance')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks metadata hostname with trailing dot', async () => {
    await expect(validateNavigationUrl('http://metadata.google.internal./computeMetadata/v1/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks metadata IP in hex form', async () => {
    await expect(validateNavigationUrl('http://0xA9FEA9FE/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks metadata IP in decimal form', async () => {
    await expect(validateNavigationUrl('http://2852039166/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks metadata IP in octal form', async () => {
    await expect(validateNavigationUrl('http://0251.0376.0251.0376/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks IPv6 metadata with brackets (fd00::)', async () => {
    await expect(validateNavigationUrl('http://[fd00::]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks IPv6 ULA fd00::1 (not just fd00::)', async () => {
    await expect(validateNavigationUrl('http://[fd00::1]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks IPv6 ULA fd12:3456::1', async () => {
    await expect(validateNavigationUrl('http://[fd12:3456::1]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('blocks IPv6 ULA fc00:: (full fc00::/7 range)', async () => {
    await expect(validateNavigationUrl('http://[fc00::]/')).rejects.toThrow(/cloud metadata/i);
  });

  it('does not block hostnames starting with fd (e.g. fd.example.com)', async () => {
    await expect(validateNavigationUrl('https://fd.example.com/')).resolves.toBeUndefined();
  });

  it('does not block hostnames starting with fc (e.g. fcustomer.com)', async () => {
    await expect(validateNavigationUrl('https://fcustomer.com/')).resolves.toBeUndefined();
  });

  it('throws on malformed URLs', async () => {
    await expect(validateNavigationUrl('not-a-url')).rejects.toThrow(/Invalid URL/i);
  });
});

describe('validateNavigationUrl — restoreState coverage', () => {
  it('blocks file:// URLs that could appear in saved state', async () => {
    await expect(validateNavigationUrl('file:///etc/passwd')).rejects.toThrow(/scheme.*not allowed/i);
  });

  it('blocks chrome:// URLs that could appear in saved state', async () => {
    await expect(validateNavigationUrl('chrome://settings')).rejects.toThrow(/scheme.*not allowed/i);
  });

  it('blocks metadata IPs that could be injected into state files', async () => {
    await expect(validateNavigationUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/cloud metadata/i);
  });

  it('allows normal https URLs from saved state', async () => {
    await expect(validateNavigationUrl('https://example.com/page')).resolves.toBeUndefined();
  });

  it('allows localhost URLs from saved state', async () => {
    await expect(validateNavigationUrl('http://localhost:3000/app')).resolves.toBeUndefined();
  });
});

describe('normalizeLocalhostToIPv4', () => {
  it('将 localhost 替换为 127.0.0.1', () => {
    const { normalizeLocalhostToIPv4 } = require('../src/url-validation');
    expect(normalizeLocalhostToIPv4('http://localhost:3000')).toBe('http://127.0.0.1:3000/');
  });

  it('处理不带端口的 localhost', () => {
    const { normalizeLocalhostToIPv4 } = require('../src/url-validation');
    expect(normalizeLocalhostToIPv4('http://localhost/path')).toBe('http://127.0.0.1/path');
  });

  it('处理 https 协议的 localhost', () => {
    const { normalizeLocalhostToIPv4 } = require('../src/url-validation');
    expect(normalizeLocalhostToIPv4('https://localhost:8080')).toBe('https://127.0.0.1:8080/');
  });

  it('保留 127.0.0.1 不变', () => {
    const { normalizeLocalhostToIPv4 } = require('../src/url-validation');
    expect(normalizeLocalhostToIPv4('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });

  it('保留外部域名不变', () => {
    const { normalizeLocalhostToIPv4 } = require('../src/url-validation');
    expect(normalizeLocalhostToIPv4('https://example.com')).toBe('https://example.com');
  });

  it('处理大写的 LOCALHOST', () => {
    const { normalizeLocalhostToIPv4 } = require('../src/url-validation');
    expect(normalizeLocalhostToIPv4('http://LOCALHOST:3000')).toBe('http://127.0.0.1:3000/');
  });

  it('保留 IPv6 环回地址不变', () => {
    const { normalizeLocalhostToIPv4 } = require('../src/url-validation');
    expect(normalizeLocalhostToIPv4('http://[::1]:3000')).toBe('http://[::1]:3000');
  });

  it('不替换路径或查询参数中的 localhost', () => {
    const { normalizeLocalhostToIPv4 } = require('../src/url-validation');
    expect(normalizeLocalhostToIPv4('http://example.com/?redirect=localhost')).toBe(
      'http://example.com/?redirect=localhost'
    );
  });

  it('无效 URL 直接透传', () => {
    const { normalizeLocalhostToIPv4 } = require('../src/url-validation');
    expect(normalizeLocalhostToIPv4('not-a-url')).toBe('not-a-url');
  });
});

describe('prepareNavigationUrl', () => {
  it('返回规范化后的 URL 并通过验证', async () => {
    const { prepareNavigationUrl } = require('../src/url-validation');
    const result = await prepareNavigationUrl('http://localhost:3000');
    expect(result).toBe('http://127.0.0.1:3000/');
  });

  it('对危险 URL 仍然抛出错误', async () => {
    const { prepareNavigationUrl } = require('../src/url-validation');
    await expect(prepareNavigationUrl('http://169.254.169.254/')).rejects.toThrow(/cloud metadata/i);
  });

  it('对无效 URL 仍然抛出错误', async () => {
    const { prepareNavigationUrl } = require('../src/url-validation');
    await expect(prepareNavigationUrl('not-a-url')).rejects.toThrow(/Invalid URL/i);
  });
});
