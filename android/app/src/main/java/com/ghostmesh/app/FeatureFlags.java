package com.ghostmesh.app;

/**
 * Feature flags for the Ghost Mesh Android application.
 *
 * Use these to turn features on and off without changing core logic.
 * For example, the voice changer feature can be disabled here before an
 * Indus App Store publish if the store asks for it to be removed.
 */
public final class FeatureFlags {

    private FeatureFlags() {
        // utility class
    }

    /**
     * When true, the voice changer UI and processing are available.
     *
     * Set to false before publishing if the store requests the feature be removed.
     */
    public static final boolean ENABLE_VOICE_CHANGER = true;
}
