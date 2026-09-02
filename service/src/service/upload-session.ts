type RegisterUploadSession = (sessionKey: string) => Promise<unknown>;

export interface UploadSessionRegistrar {
  (sessionKey: string): Promise<unknown>;
  /**
   * Rejects the shared registration barrier only while Redis is still
   * pending. The underlying Redis promise remains observed, but its eventual
   * outcome cannot reopen the barrier or forward a file after timeout.
   */
  rejectPending(error: Error): boolean;
}

/**
 * Creates a request-scoped session registrar. Every file shares the first
 * registration promise, allowing callers to wait for the Redis write without
 * issuing duplicate SETs for a batch.
 */
export function createUploadSessionRegistrar(
  registerSession: RegisterUploadSession,
): UploadSessionRegistrar {
  let sessionRegistered: Promise<unknown> | undefined;
  let registrationPending = false;
  let resolveRegistration!: (value: unknown) => void;
  let rejectRegistration!: (error: unknown) => void;

  const ensureSessionRegistered = (sessionKey: string): Promise<unknown> => {
    if (!sessionRegistered) {
      registrationPending = true;
      sessionRegistered = new Promise((resolve, reject) => {
        resolveRegistration = resolve;
        rejectRegistration = reject;
      });

      let registration: Promise<unknown>;
      try {
        registration = registerSession(sessionKey);
      } catch (error) {
        registrationPending = false;
        rejectRegistration(error);
        return sessionRegistered;
      }

      void registration.then(
        (value) => {
          if (!registrationPending) return;
          registrationPending = false;
          resolveRegistration(value);
        },
        (error: unknown) => {
          if (!registrationPending) return;
          registrationPending = false;
          rejectRegistration(error);
        },
      );
    }
    return sessionRegistered;
  };

  ensureSessionRegistered.rejectPending = (error: Error): boolean => {
    if (!registrationPending) return false;
    registrationPending = false;
    rejectRegistration(error);
    return true;
  };

  return ensureSessionRegistered;
}
