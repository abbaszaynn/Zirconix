import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { supabase } from './supabase';
import type { Director, Entity } from './database.types';

const ACTIVE_ENTITY_KEY = 'zirconix.activeEntityId';

type SessionState = {
  loading: boolean;
  session: Session | null;
  /** The director record for this user. Null means "signed in but not on the list". */
  director: Director | null;
  entities: Entity[];
  activeEntity: Entity | null;
  setActiveEntity: (entityId: string) => void;
  /** aal2 — this session passed a TOTP challenge. Required to approve. */
  hasMfaSession: boolean;
  /** Whether a verified TOTP factor exists on the account at all. */
  hasEnrolledMfa: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [director, setDirector] = useState<Director | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [activeEntityId, setActiveEntityId] = useState<string | null>(null);
  const [hasMfaSession, setHasMfaSession] = useState(false);
  const [hasEnrolledMfa, setHasEnrolledMfa] = useState(false);

  const loadProfile = useCallback(async (current: Session | null) => {
    if (!current) {
      setDirector(null);
      setEntities([]);
      setHasMfaSession(false);
      setHasEnrolledMfa(false);
      return;
    }

    // RLS returns only this user's own row here.
    const [{ data: dir }, { data: ents }, aal] = await Promise.all([
      supabase.from('directors').select('*').eq('auth_user_id', current.user.id).maybeSingle(),
      supabase.from('entities').select('*').order('name'),
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);

    setDirector((dir as Director) ?? null);
    setEntities((ents as Entity[]) ?? []);
    setHasMfaSession(aal.data?.currentLevel === 'aal2');
    setHasEnrolledMfa(aal.data?.nextLevel === 'aal2');
  }, []);

  useEffect(() => {
    let alive = true;

    (async () => {
      const [{ data }, stored] = await Promise.all([
        supabase.auth.getSession(),
        AsyncStorage.getItem(ACTIVE_ENTITY_KEY),
      ]);
      if (!alive) return;

      setSession(data.session);
      setActiveEntityId(stored);
      await loadProfile(data.session);
      if (alive) setLoading(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      // Fire and forget: the UI already reflects the new session, and the
      // profile fills in a tick later.
      void loadProfile(next);
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const activeEntity = useMemo(() => {
    if (entities.length === 0) return null;
    return entities.find((e) => e.id === activeEntityId) ?? entities[0];
  }, [entities, activeEntityId]);

  const setActiveEntity = useCallback((entityId: string) => {
    setActiveEntityId(entityId);
    void AsyncStorage.setItem(ACTIVE_ENTITY_KEY, entityId);
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      loading,
      session,
      director,
      entities,
      activeEntity,
      setActiveEntity,
      hasMfaSession,
      hasEnrolledMfa,
      refresh: async () => {
        const { data } = await supabase.auth.getSession();
        setSession(data.session);
        await loadProfile(data.session);
      },
      signOut: async () => {
        await supabase.auth.signOut();
        setDirector(null);
        setEntities([]);
      },
    }),
    [
      loading,
      session,
      director,
      entities,
      activeEntity,
      setActiveEntity,
      hasMfaSession,
      hasEnrolledMfa,
      loadProfile,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
