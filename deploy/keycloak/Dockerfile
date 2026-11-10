# Keycloak built once for this installation (setup-server.sh), so each start skips Keycloak's own build step ("start --optimized"):
# faster restarts and less memory, which matters on a small server. Build-time options only; everything else is runtime
# configuration in /etc/hrms/keycloak.env.
#   docker build --build-arg KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.8.2 -t hrms/keycloak:26.8.2 deploy/keycloak
ARG KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.8.2
FROM ${KEYCLOAK_IMAGE} AS builder
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_HTTP_RELATIVE_PATH=/kc \
    KC_CACHE=local
RUN /opt/keycloak/bin/kc.sh build

FROM ${KEYCLOAK_IMAGE}
COPY --from=builder /opt/keycloak/ /opt/keycloak/
# The HRMS look for the sign-in pages (themes/hrms; the hrms realm's loginTheme, set by configure-realm.sh). Owned by Keycloak's user
# (1000), so it stays readable whatever the permissions of the folder the image is built from.
COPY --chown=1000:0 themes/ /opt/keycloak/themes/
