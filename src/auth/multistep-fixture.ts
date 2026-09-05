import type { FixtureRoute } from "../runtime/index.js";

export const MULTISTEP_FIXTURE_EMAIL = "person@example.com";
export const MULTISTEP_FIXTURE_PASSWORD = "correct horse battery staple";
export const MULTISTEP_FIXTURE_OTP = "246810";

export function multistepAuthFixtureRoutes(): Record<string, FixtureRoute> {
  return {
    "/login": {
      html: `<!doctype html>
        <title>Email</title>
        <form>
          <label>Email <input type="email" autocomplete="username" required></label>
          <button>Continue</button>
        </form>
        <script>
          document.querySelector("form").addEventListener("submit", (event) => {
            event.preventDefault();
            sessionStorage.setItem("email", document.querySelector("input").value);
            location.href = "/password";
          });
        </script>`,
    },
    "/password": {
      html: `<!doctype html>
        <title>Password</title>
        <form>
          <label>Password <input type="password" autocomplete="current-password" required></label>
          <button>Continue</button>
          <p id="error"></p>
        </form>
        <script>
          document.querySelector("form").addEventListener("submit", (event) => {
            event.preventDefault();
            if (document.querySelector("input").value !== ${JSON.stringify(MULTISTEP_FIXTURE_PASSWORD)}) {
              document.querySelector("#error").textContent = "Invalid password";
              return;
            }
            location.href = "/otp";
          });
        </script>`,
    },
    "/otp": {
      html: `<!doctype html>
        <title>Security code</title>
        <form>
          <label>Security code <input inputmode="numeric" autocomplete="one-time-code" required></label>
          <button>Verify</button>
          <p id="error"></p>
        </form>
        <script>
          document.querySelector("form").addEventListener("submit", (event) => {
            event.preventDefault();
            if (document.querySelector("input").value !== ${JSON.stringify(MULTISTEP_FIXTURE_OTP)}) {
              document.querySelector("#error").textContent = "Invalid code";
              return;
            }
            document.cookie = "session=authenticated; path=/; Max-Age=3600; SameSite=Lax";
            localStorage.setItem("authenticated", "true");
            location.href = "/account";
          });
        </script>`,
    },
    "/account": {
      html: `<!doctype html>
        <title>Account</title>
        <button data-testid="user-menu">User menu</button>`,
    },
  };
}
