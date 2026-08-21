import { describe, expect, test } from 'bun:test';
import { hostedAppUpstreamUrl } from './preview-proxy';

describe('hosted app preview upstream URL', () => {
  test('keeps protocol-relative and ordinary request paths on the AWS endpoint origin', () => {
    const endpoint = 'https://vm.aws.example/';
    expect(hostedAppUpstreamUrl(endpoint, '/assets/app.js').toString())
      .toBe('https://vm.aws.example/assets/app.js');
    expect(hostedAppUpstreamUrl(endpoint, '//attacker.example/steal').origin)
      .toBe('https://vm.aws.example');
    expect(hostedAppUpstreamUrl(endpoint, '//attacker.example/steal').pathname)
      .toBe('//attacker.example/steal');
  });

  test('rejects non-HTTPS and credential-bearing endpoints', () => {
    expect(() => hostedAppUpstreamUrl('http://vm.aws.example', '/')).toThrow(
      'Hosted app endpoint is invalid',
    );
    expect(() => hostedAppUpstreamUrl('https://user@vm.aws.example', '/')).toThrow(
      'Hosted app endpoint is invalid',
    );
  });
});
