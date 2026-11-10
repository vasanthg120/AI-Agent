import * as fs from 'fs';
import * as path from 'path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { moduleById } from './app-modules';
import { PERMISSION_EXEMPT_KEY, PERMISSION_KEY, permissionFor } from './permission.decorator';

// Every route in the app is either part of a module of the permission catalog or
// marked as deliberately outside it. A new controller that is neither fails here,
// so a person's permission list can never be silently skipped by a forgotten tag.

const SRC = path.join(__dirname, '..', '..');
const reflector = new Reflector();

// eslint-disable-next-line @typescript-eslint/ban-types
type Route = { controller: string; handler: string; method: string; fn: Function; cls: Function };

function allRoutes(): Route[] {
  const files = (fs.readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith('.controller.ts'));
  const routes: Route[] = [];
  for (const file of files) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exported = require(path.join(SRC, file)) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (typeof value !== 'function' || Reflect.getMetadata(PATH_METADATA, value) === undefined) continue;
      const proto = value.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const fn = proto[name];
        if (name === 'constructor' || typeof fn !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
        if (method === undefined || Reflect.getMetadata(PATH_METADATA, fn) === undefined) continue;
        routes.push({ controller: `${file}:${value.name}`, handler: name, method: RequestMethod[method], fn, cls: value });
      }
    }
  }
  return routes;
}

describe('permission coverage', () => {
  const routes = allRoutes();

  it('finds the app’s routes', () => {
    expect(routes.length).toBeGreaterThan(300);
  });

  it('every route belongs to a module or is marked as outside the catalog', () => {
    const untagged = routes.filter(
      (r) =>
        !reflector.get(PERMISSION_KEY, r.fn) &&
        !reflector.get(PERMISSION_EXEMPT_KEY, r.fn) &&
        !reflector.get(PERMISSION_KEY, r.cls) &&
        !reflector.get(PERMISSION_EXEMPT_KEY, r.cls),
    );
    expect(untagged.map((r) => `${r.controller}.${r.handler}`)).toEqual([]);
  });

  it('every tagged route needs an action its module really has', () => {
    const wrong = routes
      .map((r) => ({ r, need: permissionFor(reflector, r.fn, r.cls, r.method) }))
      .filter(({ need }) => need && need.anyOf.some((m) => !(moduleById(m)?.actions as readonly string[] | undefined)?.includes(need.action)))
      .map(({ r, need }) => `${r.controller}.${r.handler} → ${need!.anyOf.join('|')}:${need!.action}`);
    expect(wrong).toEqual([]);
  });
});
