export type DeployProfileFieldError = {
  code: "PROFILE_INVALID";
  message: string;
  path: string;
  hint: string;
};

export function deployProfileBaseUrlError(baseUrl: string | null, path: string): DeployProfileFieldError | null {
  if (baseUrl === null) {
    return {
      code: "PROFILE_INVALID",
      message: "GitHub Pages deploy profile must define base_url.",
      path,
      hint: "Regenerate it with llm-wiki deploy github-pages init.",
    };
  }

  if (!deployProfileBaseUrlIsValid(baseUrl)) {
    return {
      code: "PROFILE_INVALID",
      message: "GitHub Pages deploy profile base_url must be an absolute HTTPS URL.",
      path,
      hint: "Set base_url to a URL such as https://owner.github.io/repo, without credentials, ports, query strings, fragments, or unsafe path segments.",
    };
  }

  return null;
}

export function deployProfileCustomDomainError(customDomain: string | null, path: string): DeployProfileFieldError | null {
  if (customDomain === null || customDomainHostIsValid(customDomain)) {
    return null;
  }

  return {
    code: "PROFILE_INVALID",
    message: "GitHub Pages deploy profile custom_domain must be a host name only.",
    path,
    hint: "Set custom_domain to a host name such as docs.example.com, without a path, query, fragment, or port.",
  };
}

export function deployProfileCustomDomainBaseUrlError(
  baseUrl: string | null,
  customDomain: string | null,
  path: string,
): DeployProfileFieldError | null {
  if (baseUrl === null || customDomain === null) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }

  if (url.hostname.toLowerCase() === customDomain.toLowerCase()) {
    if (url.pathname === "/") {
      return null;
    }

    return {
      code: "PROFILE_INVALID",
      message: "GitHub Pages deploy profile base_url must use custom_domain at the domain root.",
      path,
      hint: `Set base_url to https://${customDomain} or remove custom_domain from the deploy profile.`,
    };
  }

  return {
    code: "PROFILE_INVALID",
    message: "GitHub Pages deploy profile base_url host must match custom_domain.",
    path,
    hint: `Set base_url to https://${customDomain} or remove custom_domain from the deploy profile.`,
  };
}

function deployProfileBaseUrlIsValid(value: string): boolean {
  if (
    value.trim() !== value ||
    value === "" ||
    value.includes("\\") ||
    /\s/u.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /\/(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/iu.test(value)
  ) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "" &&
    customDomainHostIsValid(url.hostname) &&
    deployProfileBaseUrlPathIsSafe(url.pathname);
}

function deployProfileBaseUrlPathIsSafe(pathname: string): boolean {
  if (pathname === "" || pathname === "/") {
    return true;
  }

  if (!pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("//")) {
    return false;
  }

  return pathname
    .split("/")
    .filter((segment) => segment !== "")
    .every((segment) => {
      let decodedSegment: string;
      try {
        decodedSegment = decodeURIComponent(segment);
      } catch {
        return false;
      }

      return decodedSegment !== "." &&
        decodedSegment !== ".." &&
        !decodedSegment.includes("\\") &&
        !/[\u0000-\u001f\u007f]/u.test(decodedSegment);
    });
}

export function customDomainHostIsValid(value: string): boolean {
  if (
    value.trim() !== value ||
    value === "" ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes(":") ||
    /\s/u.test(value)
  ) {
    return false;
  }

  const labels = value.toLowerCase().split(".");
  return value.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
}
