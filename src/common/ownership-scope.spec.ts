import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import {
  Actor,
  FIRM_WIDE,
  assertCanAccessClient,
  assertFirmWide,
  assertOwns,
  canAccessClient,
  clientScope,
  clientWhere,
  isFirmWide,
  ownedWhere,
  ownerForCreate,
  relatedClientWhere,
} from './ownership-scope';

const superAdmin: Actor = { id: 'u_super', role: Role.SUPER_ADMIN };
const legacyAdmin: Actor = { id: 'u_admin', role: Role.ADMIN };
const deep: Actor = { id: 'u_deep', role: Role.PORTFOLIO_MANAGER };
const other: Actor = { id: 'u_other', role: Role.PORTFOLIO_MANAGER };
const analyst: Actor = { id: 'u_analyst', role: Role.RESEARCH_ANALYST };
const clientLogin: Actor = { id: 'u_view', role: Role.VIEWER, clientId: 'c_1' };

describe('ownership-scope', () => {
  describe('isFirmWide', () => {
    it('is true only for the admin tiers', () => {
      expect(isFirmWide(superAdmin)).toBe(true);
      expect(isFirmWide(legacyAdmin)).toBe(true);
      expect(isFirmWide(deep)).toBe(false);
      expect(isFirmWide(analyst)).toBe(false);
      expect(isFirmWide(clientLogin)).toBe(false);
    });

    it('fails closed on a missing actor rather than granting the firm', () => {
      expect(isFirmWide(undefined)).toBe(false);
      expect(isFirmWide(null)).toBe(false);
    });
  });

  describe('clientScope', () => {
    it('gives a Super Admin the unscoped marker', () => {
      expect(clientScope(superAdmin)).toBe(FIRM_WIDE);
    });

    it("narrows a manager to their own ownerId", () => {
      expect(clientScope(deep)).toEqual({ ownerId: 'u_deep' });
    });

    it('narrows a research analyst the same way', () => {
      expect(clientScope(analyst)).toEqual({ ownerId: 'u_analyst' });
    });

    it('pins a client login to its single mandate', () => {
      expect(clientScope(clientLogin)).toEqual({ id: 'c_1' });
    });

    it('matches nothing for a client login whose mandate was deleted', () => {
      const orphan: Actor = { id: 'u_x', role: Role.VIEWER, clientId: null };
      // The important half is that it is NOT FIRM_WIDE.
      expect(clientScope(orphan)).not.toBe(FIRM_WIDE);
      expect(clientScope(orphan)).toEqual({ id: '__no_client__' });
    });
  });

  describe('clientWhere / relatedClientWhere', () => {
    it('spreads to nothing for a Super Admin', () => {
      expect(clientWhere(superAdmin)).toEqual({});
      expect(relatedClientWhere(superAdmin)).toEqual({});
    });

    it('spreads to an owner filter for a manager', () => {
      expect(clientWhere(deep)).toEqual({ ownerId: 'u_deep' });
    });

    it('nests under `client` for holdings/transactions', () => {
      expect(relatedClientWhere(deep)).toEqual({
        client: { ownerId: 'u_deep' },
      });
    });

    it('composes with a market filter without either clobbering the other', () => {
      const where = { ...clientWhere(deep), market: 'INDIA' };
      expect(where).toEqual({ ownerId: 'u_deep', market: 'INDIA' });
    });
  });

  describe('ownedWhere', () => {
    it('is unscoped for a Super Admin and self-scoped for a manager', () => {
      expect(ownedWhere(superAdmin)).toEqual({});
      expect(ownedWhere(deep)).toEqual({ ownerId: 'u_deep' });
    });

    it('gives a client login no families or watchlists at all', () => {
      expect(ownedWhere(clientLogin)).toEqual({ ownerId: '__no_owner__' });
    });
  });

  describe('ownerForCreate', () => {
    it('makes a manager own what they create, ignoring any requested owner', () => {
      expect(ownerForCreate(deep)).toBe('u_deep');
      // A manager must not be able to file a mandate under someone else.
      expect(ownerForCreate(deep, 'u_other')).toBe('u_deep');
    });

    it('lets a Super Admin assign to a named manager', () => {
      expect(ownerForCreate(superAdmin, 'u_deep')).toBe('u_deep');
    });

    it('leaves a Super Admin creation UNASSIGNED when no manager is named', () => {
      // Not owned by the Super Admin — see ownerForCreate's rationale.
      expect(ownerForCreate(superAdmin)).toBeNull();
    });
  });

  describe('canAccessClient', () => {
    const mine = { id: 'c_mine', ownerId: 'u_deep' };
    const theirs = { id: 'c_theirs', ownerId: 'u_other' };
    const unassigned: { id: string; ownerId: string | null } = {
      id: 'c_orphan',
      ownerId: null,
    };

    it('lets a manager reach their own client only', () => {
      expect(canAccessClient(deep, mine)).toBe(true);
      expect(canAccessClient(deep, theirs)).toBe(false);
    });

    it('hides an UNASSIGNED mandate from every manager', () => {
      expect(canAccessClient(deep, unassigned)).toBe(false);
      expect(canAccessClient(other, unassigned)).toBe(false);
    });

    it('shows an unassigned mandate to a Super Admin', () => {
      expect(canAccessClient(superAdmin, unassigned)).toBe(true);
      expect(canAccessClient(superAdmin, theirs)).toBe(true);
    });

    it('lets a client login reach only its own mandate', () => {
      expect(canAccessClient(clientLogin, { id: 'c_1', ownerId: 'u_deep' })).toBe(true);
      expect(canAccessClient(clientLogin, { id: 'c_2', ownerId: 'u_deep' })).toBe(false);
    });

    it('is false for a missing row', () => {
      expect(canAccessClient(superAdmin, null)).toBe(false);
      expect(canAccessClient(deep, undefined)).toBe(false);
    });
  });

  describe('assertCanAccessClient', () => {
    it('passes silently for the owner', () => {
      expect(() =>
        assertCanAccessClient(deep, { id: 'c', ownerId: 'u_deep' }),
      ).not.toThrow();
    });

    it("throws NotFound — never Forbidden — for another manager's client", () => {
      // A 403 would confirm the id exists and turn enumeration into a census.
      expect(() =>
        assertCanAccessClient(deep, { id: 'c', ownerId: 'u_other' }),
      ).toThrow(NotFoundException);
    });

    it('throws the same NotFound for an absent record, so the two are indistinguishable', () => {
      let missing: unknown;
      let forbidden: unknown;
      try {
        assertCanAccessClient(deep, null);
      } catch (e) {
        missing = e;
      }
      try {
        assertCanAccessClient(deep, { id: 'c', ownerId: 'u_other' });
      } catch (e) {
        forbidden = e;
      }
      expect((missing as Error).constructor).toBe((forbidden as Error).constructor);
      expect((missing as Error).message).toBe((forbidden as Error).message);
    });
  });

  describe('assertOwns', () => {
    it("throws NotFound for another manager's family", () => {
      expect(() => assertOwns(deep, { ownerId: 'u_other' }, 'Family')).toThrow(
        NotFoundException,
      );
    });

    it('allows the owner and any Super Admin', () => {
      expect(() => assertOwns(deep, { ownerId: 'u_deep' })).not.toThrow();
      expect(() => assertOwns(superAdmin, { ownerId: 'u_other' })).not.toThrow();
    });
  });

  describe('assertFirmWide', () => {
    it('throws Forbidden for a manager', () => {
      // Forbidden is right here: an admin capability is not a secret.
      expect(() => assertFirmWide(deep)).toThrow(ForbiddenException);
    });

    it('passes for a Super Admin', () => {
      expect(() => assertFirmWide(superAdmin)).not.toThrow();
    });
  });
});
