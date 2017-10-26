/**
 * script.js
 * modernizr checks & preloading
 */

// image preloading for lazy loading of background
function preloadImage(url, callback) {
    var img = new Image();
    img.src = url;
    img.onload = callback;
}

// Event listener for contact elements, toggles 'show' class
function addHoverListeners(el, toggle) {
    el.addEventListener('mouseover', function() {
        toggleShowClass(toggle);
    }, false);

    el.addEventListener('mouseout', function() {
        toggleShowClass(toggle);
    }, false);
}

// Toggles the show class for contact list elements, this show class displays url or other info
function toggleShowClass(el) {
    if (el.classList) {
        el.classList.toggle('show');
    } else {
        var classes = el.className.split(' ');
        var existingIndex = classes.indexOf('show');
        if (existingIndex >= 0) {
            classes.splice(existingIndex, 1);
        } else {
            classes.push(className);
        }

        el.className = classes.join(' ');
    }
}

window.onload = function() {
    // contact buttons
    var mail = document.getElementById('mail');
    var github = document.getElementById('github');
    var linkedin = document.getElementById('linkedin');
    var stackoverflow = document.getElementById('stackoverflow');
    var location = document.getElementById('location');
    //document.body.style.backgroundImage = 'url(./assets/images/anthony-delanoix.jpg)';
    preloadImage('./assets/images/anthony-delanoix.jpg', function() {
        document.body.style.backgroundImage = 'url(./assets/images/anthony-delanoix.jpg)';
        setTimeout(function() {
            document.getElementById('bg-image').style.display = 'none';
        }, 50);
    });

    if (Modernizr.svg) {
        console.log('svg');
    } else {
        mail.src = 'assets/images/' + mail + '.png';
        github.src = 'assets/images/' + github + '.png';
        linkedin.src = 'assets/images/' + linkedin + '.png';
        stackoverflow.src = 'assets/images/' + stackoverflow + '.png';
        location.src = 'assets/images/' + location + '.png';
    }

    // If transitions are supported then we add the hover listener
    /*
    if (Modernizr.csstransitions) {
        var contacts = document.querySelectorAll('.contact-el');
        var imgs = document.querySelectorAll('.contact-el > a > img');

        // this is kind of a hacky way of doing this
        for (var i = 0; i < imgs.length; i++) {
            for (var j = 0; j < contacts.length; j++) {
                addHoverListeners(imgs[i], contacts[i]);
            }
        }
    }
    */
}
